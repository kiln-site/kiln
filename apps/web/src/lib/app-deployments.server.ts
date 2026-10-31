import { randomUUID } from "node:crypto"

import {
  relayAppGitHubV1Feature,
  relayAppDeploymentLogSchema,
  relayAppImageUpdatesV1Feature,
  relayAppSchema,
  type AppConfig,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Fiber,
  Result,
  Schedule,
  Schema,
} from "effect"
import { Activity } from "effect/workflow"

import {
  finishAppDeploymentEffect,
  insertAppDeploymentEffect,
  latestAppDeploymentsEffect,
  loadAppGitHubSourceEffect,
  loadAppDeploymentRequestsEffect,
  loadAutoDeployGitHubSourcesEffect,
  loadRunningAppDeploymentsEffect,
  recordRelayDeploymentEffect,
  requestAppDeploymentEffect,
  takeAppDeploymentRequestEffect,
  type AppDeploymentAsk,
  type AppDeploymentRecord,
  type AppDeploymentRequestRow,
  type AppDeploymentStatus,
  type AppDeploymentTrigger,
} from "@/effect/app-deployments"
import {
  autoUpdateAt,
  currentImageUpdate,
  claimImageUpdateEffect,
  loadAppImageUpdateEffect,
} from "@/effect/app-image-updates"
import type { Database } from "@/effect/database"
import { DatabaseError, ExternalServiceError } from "@/effect/errors"
import {
  getGitHubCommitEffect,
  githubInstallationTokenEffect,
  githubRepositoryReadTokenEffect,
} from "@/effect/github-api"
import { loadGitHubConnectionCredentialEffect } from "@/effect/github-sync"
import { loadAppConfigEffect } from "@/effect/managed-apps"
import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import {
  findResourceDeletionEffect,
  unfinishedDeletionStatuses,
} from "@/effect/resource-deletions"
import { forkAppWorker } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import { outsideOperation } from "@/operations/current"
import {
  durableOperation,
  queueDurableOperation,
  whileMySqlIsAway,
} from "@/operations/durable"
import { currentActingUser } from "@/operations/acting-user"
import { developmentBypassUserId } from "@/lib/development-bypass"
import { loadOperation } from "@/operations/records"
import { RelayCommandError, relayCommand } from "@/operations/relay-command"
import { appDeploymentLocks } from "@/lib/app-lanes"
import { ensureAppDatabaseConnectionsImported } from "@/lib/app-database-connections.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"

// Deploys apps and records each deployment. Every ask, whatever asked,
// joins the app's one request, and one durable operation takes it up,
// holding the app's #deploy from taking it until the Relay says the
// deployment ended, so deployments of an app go one at a time in its
// lanes, each deploying the newest ask as it stands then, with a token
// made as it's sent.

const pollInterval = "1 minute"
// A wait, as for a build to end, checks this often in memory and stores a
// step a window, so a long one keeps few. A window cut off, as Hearth
// stops, checks again from its start.
const watchWindow = Duration.minutes(5)
// A running deployment is checked often at first, then less.
const followQuickly = Duration.minutes(2)
const followInterval = Duration.seconds(2)
const followIntervalLater = Duration.seconds(10)
// How long a new app may take to provision before its first deployment.
const provisionWindows = 2

export interface AppDeploymentRequest {
  appId: string
  /** A commit to build again; otherwise the head of the app's branch. */
  commit?: string
  /**
   * The commit a push pinned, deployed while the app still deploys from the
   * repository and branch it came from (`<repository ID>/<branch>`).
   */
  pinned?: { commitSha: string; source: string }
  /** An image digest to deploy again, as a rollback of an image update. */
  imageDigest?: string
  relayId: string
  trigger: AppDeploymentTrigger
  /** Who asked, for the record and the Relay's audit; null for automation. */
  userId: string | null
}

export function publishAppDeploymentChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["app-deployments", "apps"],
    type: "hearth.invalidate",
  })
}

/**
 * What a deployment sends its Relay, decided when its turn comes: for a
 * GitHub app the commit asked for, or its branch's head, with what makes
 * the token that checks it out. The app's saved configuration, which holds
 * its secrets, and the token are read and made as it's sent and never kept,
 * as a workflow's steps are, in the clear. Null when there's nothing to deploy: a
 * push or poll for the commit the app last tried, so a failing commit or a
 * rollback isn't redeployed every minute; a poll while the Relay is
 * offline, which checks again once it's back; an image update no longer
 * due when its turn came.
 */
const DeployPlan = Schema.Struct({
  payload: Schema.Struct({
    appId: Schema.String,
    github: Schema.optionalKey(
      Schema.Struct({
        build: Schema.Unknown,
        commit: Schema.String,
        path: Schema.String,
        repository: Schema.String,
      })
    ),
    imageDigest: Schema.optionalKey(Schema.String),
    name: Schema.String,
  }),
  record: Schema.Struct({
    appId: Schema.String,
    branch: Schema.NullOr(Schema.String),
    commitAuthor: Schema.NullOr(Schema.String),
    commitMessage: Schema.NullOr(Schema.String),
    commitSha: Schema.NullOr(Schema.String),
    id: Schema.String,
    imageDigest: Schema.NullOr(Schema.String),
    relayId: Schema.String,
    repository: Schema.NullOr(Schema.String),
    sourceType: Schema.String,
    startedAt: Schema.String,
    trigger: Schema.String,
    triggeredBy: Schema.NullOr(Schema.String),
  }),
  token: Schema.NullOr(
    Schema.Struct({
      connectionId: Schema.String,
      installationId: Schema.Number,
      repositoryId: Schema.Number,
    })
  ),
})
type DeployPlan = typeof DeployPlan.Type

const prepareAppDeploymentEffect = Effect.fn("Apps.deploy.prepare")(function* (
  request: AppDeploymentRequest,
  id: string
) {
  yield* Effect.annotateCurrentSpan({
    "app.id": request.appId,
    "app.deployment.trigger": request.trigger,
    "relay.id": request.relayId,
  })
  const relay = yield* enabledRelay(request.relayId)
  const automatic = request.trigger === "push" || request.trigger === "poll"
  const autoUpdate = request.trigger === "update" && request.userId === null
  if (
    (request.trigger === "poll" || autoUpdate) &&
    relayConnectionFeatures(relay.id).size === 0
  ) {
    return null
  }
  const app = yield* loadAppConfigEffect(request.relayId, request.appId)
  if (!app) return yield* Effect.fail(new Error("App not found"))
  // An app switched to another source keeps its repository, unused.
  if (automatic && app.config.sourceType !== "github") return null
  if (request.commit && app.config.sourceType !== "github") {
    return yield* Effect.fail(
      new Error("The app no longer deploys from GitHub")
    )
  }
  // A rollback deploys its digest or nothing: pulling the tag instead could
  // deploy the very image it rolls back from.
  if (request.imageDigest !== undefined) {
    if (app.config.sourceType !== "image") {
      return yield* Effect.fail(
        new Error("The app no longer deploys from an image")
      )
    }
    if (!relayConnectionFeatures(relay.id).has(relayAppImageUpdatesV1Feature)) {
      return yield* Effect.fail(
        new Error("Update this Relay to deploy an image by its digest")
      )
    }
  }
  const imageDigest =
    request.trigger === "update"
      ? yield* imageUpdateDigest(relay, app.config, request, id)
      : request.imageDigest
  if (imageDigest === null) return null
  const github =
    app.config.sourceType === "github"
      ? yield* githubCommit(relay, request)
      : undefined
  if (github === null) return null
  // A commit deployed again, as a rollback, holds until a new one lands.
  if (github && automatic) {
    const { head } = yield* latestAppDeploymentsEffect(request.appId)
    if (head?.commitSha === github.commit.sha) return null
  }
  const plan: DeployPlan = {
    payload: {
      appId: request.appId,
      ...(github && {
        github: {
          build: github.source.build,
          commit: github.commit.sha,
          path: github.source.path,
          repository: github.source.repository,
        },
      }),
      ...(imageDigest && { imageDigest }),
      name: app.name,
    },
    record: {
      appId: request.appId,
      branch: github?.source.branch ?? null,
      commitAuthor: github?.commit.author ?? null,
      commitMessage: github?.commit.message ?? null,
      commitSha: github?.commit.sha ?? null,
      id,
      imageDigest: imageDigest ?? null,
      relayId: relay.id,
      repository: github?.source.repository ?? null,
      sourceType: app.config.sourceType,
      startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      trigger: request.trigger,
      triggeredBy: request.userId,
    },
    token: github?.token ?? null,
  }
  return plan
})

// The record of a planned deployment, as it runs.
const runningRecord = (
  plan: DeployPlan,
  relayDeploymentId: string | null
): AppDeploymentRecord => ({
  ...plan.record,
  error: null,
  finishedAt: null,
  relayDeploymentId,
  rolling: null,
  sourceType: plan.record.sourceType as AppDeploymentRecord["sourceType"],
  status: "running",
  trigger: plan.record.trigger as AppDeploymentTrigger,
})

// A GitHub deployment that failed before it knew what it deploys.
const recordRefusal = (
  request: AppDeploymentRequest,
  relayId: string,
  cause: unknown
) =>
  Clock.currentTimeMillis.pipe(
    Effect.map(
      (now) =>
        ({
          appId: request.appId,
          branch: null,
          commitAuthor: null,
          commitMessage: null,
          commitSha: null,
          error: cause instanceof Error ? cause.message : String(cause),
          finishedAt: new Date(now).toISOString(),
          id: randomUUID(),
          imageDigest: null,
          relayDeploymentId: null,
          relayId,
          repository: null,
          rolling: null,
          sourceType: "github",
          startedAt: new Date(now).toISOString(),
          status: "failed",
          trigger: request.trigger,
          triggeredBy: request.userId,
        }) satisfies AppDeploymentRecord
    ),
    Effect.tap((record) =>
      insertAppDeploymentEffect(record).pipe(
        Effect.retry({ schedule: whileMySqlIsAway })
      )
    ),
    Effect.tap(() => Effect.sync(() => publishAppDeploymentChange(relayId))),
    Effect.flatMap((record) => announceDeploymentEffect(record, "failed")),
    Effect.ignore
  )

/**
 * Tells everyone who can deploy the app how a deployment ended, unless they
 * started it. An image update that deployed answers the app's update
 * notifications: the app runs the newest image now. Other deployments leave
 * them to the check that follows, since a rollback runs an older image.
 */
const announceDeploymentEffect = Effect.fnUntraced(
  function* (
    record: Pick<
      AppDeploymentRecord,
      "appId" | "id" | "imageDigest" | "relayId" | "trigger" | "triggeredBy"
    >,
    status: AppDeploymentStatus
  ) {
    if (status !== "succeeded" && status !== "failed") return
    const [app, recipients] = yield* Effect.all([
      loadAppConfigEffect(record.relayId, record.appId),
      resourceAudienceEffect(
        {
          relayId: record.relayId,
          resourceId: record.appId,
          resourceType: "app",
        },
        "app.manage"
      ),
    ])
    if (!app) return
    const delivered = yield* notifyUsersEffect(
      recipients,
      `app.deployed:${record.id}`,
      {
        deploymentId: record.id,
        kind: "app.deployed",
        resource: {
          id: record.appId,
          name: app.name,
          relayId: record.relayId,
          type: "app",
        },
        status,
        update: record.trigger === "update",
      },
      { actorUserId: record.triggeredBy }
    )
    if (delivered > 0) publishNotificationChange(recipients)
    // The update it deployed is installed. Other deployments are settled
    // by the check that follows them.
    if (
      status === "succeeded" &&
      record.trigger === "update" &&
      record.imageDigest !== null
    ) {
      // Imported here, since image updates deploy through this module.
      const { resolveAppImageUpdateNotificationsEffect } =
        yield* Effect.promise(() => import("@/lib/app-image-updates.server"))
      yield* resolveAppImageUpdateNotificationsEffect(
        record.relayId,
        record.appId,
        {
          installedDigest: record.imageDigest,
        }
      )
    }
  },
  // The deployment is recorded either way; its notification is best effort.
  (effect, record) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), {
          operation: "Apps.deployment.announce",
          attributes: { "app.deployment.id": record.id },
        })
      )
    )
)

// What a GitHub app deploys: its branch's head, or the commit asked for,
// and what makes a token that reads only its repository.
const githubCommit = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  request: AppDeploymentRequest
) {
  const source = yield* loadAppGitHubSourceEffect(request.appId)
  // Turned off while a push or poll waited: nothing it queued deploys.
  if (
    (request.trigger === "push" || request.trigger === "poll") &&
    source &&
    !source.autoDeploy
  ) {
    return null
  }
  if (!relayConnectionFeatures(relay.id).has(relayAppGitHubV1Feature)) {
    return yield* Effect.fail(
      new Error("Update this Relay to deploy apps from GitHub")
    )
  }
  if (!source) {
    return yield* Effect.fail(
      new Error("Choose a GitHub repository for this app first")
    )
  }
  if (!source.connectionId) {
    return yield* Effect.fail(
      new Error("The app's GitHub source was removed; choose another")
    )
  }
  const connection = yield* loadGitHubConnectionCredentialEffect({
    id: source.connectionId,
  })
  const installation = connection.installation
  if (!installation) {
    return yield* Effect.fail(
      new Error("Install the GitHub App before deploying from it")
    )
  }
  if (installation.suspended) {
    return yield* Effect.fail(
      new Error(`The GitHub App is suspended on ${installation.accountLogin}`)
    )
  }
  const credentials = {
    appId: connection.appId,
    privateKey: connection.privateKey,
  }
  const commit = yield* getGitHubCommitEffect(
    yield* githubInstallationTokenEffect(credentials, installation.id),
    source.repository,
    request.commit ??
      (request.pinned?.source === `${source.repositoryId}/${source.branch}`
        ? request.pinned.commitSha
        : source.branch)
  )
  return {
    commit,
    source,
    token: {
      connectionId: source.connectionId,
      installationId: installation.id,
      repositoryId: source.repositoryId,
    },
  }
})

// A token that checks out only the app's repository, made as it's sent.
const checkoutToken = Effect.fnUntraced(function* (
  token: NonNullable<DeployPlan["token"]>
) {
  const connection = yield* loadGitHubConnectionCredentialEffect({
    id: token.connectionId,
  })
  return yield* githubRepositoryReadTokenEffect(
    { appId: connection.appId, privateKey: connection.privateKey },
    token.installationId,
    token.repositoryId
  )
})

/**
 * The digest an image update deploys: the one Kiln last found the app's
 * tag naming. Kiln's own update checks again when its turn comes, so one
 * turned off or skipped while it waited doesn't deploy, nor does a digest
 * an update already tried, however it went.
 */
const imageUpdateDigest = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  config: AppConfig,
  request: AppDeploymentRequest,
  deploymentId: string
) {
  if (!relayConnectionFeatures(relay.id).has(relayAppImageUpdatesV1Feature)) {
    return yield* Effect.fail(
      new Error("Update this Relay to deploy image updates")
    )
  }
  // What a check found counts only while it still describes the App.
  const [recorded, { latest }] = yield* Effect.all([
    loadAppImageUpdateEffect(request.appId),
    latestAppDeploymentsEffect(request.appId),
  ])
  const update =
    config.sourceType === "image"
      ? currentImageUpdate(recorded, config.image, latest?.startedAt ?? null)
      : null
  const digest = update?.state === "available" ? update.latestDigest : null
  if (request.userId !== null) {
    if (digest === null) {
      return yield* Effect.fail(new Error("There's no update to deploy"))
    }
    // Someone asked: it deploys whatever came of it before, and an
    // automatic update won't try it again.
    yield* claimImageUpdateEffect(request.appId, digest, deploymentId)
    return digest
  }
  const due = update && autoUpdateAt(update)
  if (
    digest === null ||
    due === null ||
    due === undefined ||
    due > (yield* Clock.currentTimeMillis)
  ) {
    return null
  }
  // Claimed before the Relay hears of it, so no failure after can deploy
  // it twice.
  return (yield* claimImageUpdateEffect(request.appId, digest, deploymentId))
    ? digest
    : null
})

const enabledRelay = Effect.fnUntraced(function* (relayId: string) {
  const relays = yield* listPersistedRelaysEffect()
  const relay = relays.find((item) => item.id === relayId && item.enabled)
  if (!relay) {
    return yield* Effect.fail(new Error("The Relay is no longer available"))
  }
  return relay
})

/**
 * Whether a recorded deployment ended on its Relay, recording how if so.
 * One the Relay no longer knows, because it restarted or moved on, ends as
 * unknown.
 */
const checkAppDeploymentEffect = Effect.fn("Apps.deployment.check")(function* (
  record: AppDeploymentRecord
) {
  const relays = yield* listPersistedRelaysEffect()
  const relay = relays.find((item) => item.id === record.relayId)
  // A paused or offline Relay finishes its deployments when it's back.
  if (!relay?.enabled || relayConnectionFeatures(relay.id).size === 0) {
    return false
  }
  const app = yield* readRelayApp(relay, record.appId)
  const deployment = app?.deployment ?? null
  if (deployment?.id === record.relayDeploymentId) {
    if (deployment.state === "running") return false
    const finished = yield* finishAppDeploymentEffect(record.id, {
      error: deployment.error,
      finishedAt: deployment.finishedAt ?? new Date().toISOString(),
      rolling: deployment.rolling,
      status: deployment.state,
    })
    if (finished) {
      publishAppDeploymentChange(record.relayId)
      yield* announceDeploymentEffect(record, deployment.state)
    }
    return true
  }
  // The Relay moved on to another deployment; its log of this one says
  // how it ended.
  const kept =
    app && relayConnectionFeatures(relay.id).has(relayAppGitHubV1Feature)
      ? yield* readRelayDeployment(relay, record)
      : null
  if (kept && kept.state !== "running") {
    const finished = yield* finishAppDeploymentEffect(record.id, {
      error: kept.error,
      finishedAt: kept.finishedAt ?? new Date().toISOString(),
      rolling: kept.rolling,
      status: kept.state,
    })
    if (finished) {
      publishAppDeploymentChange(record.relayId)
      yield* announceDeploymentEffect(record, kept.state)
    }
    return true
  }
  const finished = yield* finishAppDeploymentEffect(record.id, {
    error: app
      ? "Kiln lost track of this deployment; its app's logs show what happened"
      : "The app is no longer on its Relay",
    finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    rolling: null,
    status: app ? "unknown" : "failed",
  })
  if (finished) publishAppDeploymentChange(record.relayId)
  return true
})

const readRelayDeployment = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  record: AppDeploymentRecord
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      relayRpc(
        relay,
        "app.deployment.read",
        { appId: record.appId, deploymentId: record.relayDeploymentId },
        15_000
      ),
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message: "Could not read the deployment from its Relay",
        service: "Relay",
      }),
  })
  const parsed = relayAppDeploymentLogSchema.safeParse(response)
  return parsed.success ? (parsed.data?.deployment ?? null) : null
})

const readRelayApp = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  appId: string
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      relayRpc(
        relay,
        "app.list",
        { requests: [{ id: appId, view: "detail" }] },
        10_000,
        undefined,
        signal
      ),
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message: "Could not read the app from its Relay",
        service: "Relay",
      }),
  })
  const item = Array.isArray(response)
    ? (response as Array<{ app?: unknown; id?: unknown; view?: unknown }>).find(
        (entry) => entry.id === appId && entry.view === "detail"
      )
    : undefined
  if (!item?.app) return null
  const parsed = relayAppSchema.safeParse(item.app)
  return parsed.success ? parsed.data : null
})

declare global {
  var kilnAppDeploymentPollFailures: Map<string, string> | undefined
  var kilnAppDeploymentPoller: Fiber.Fiber<void> | undefined
}

// Each polled app's last failure, reported once.
const pollFailures = (globalThis.kilnAppDeploymentPollFailures ??= new Map())

const DeployInput = Schema.Struct({
  appId: Schema.String,
  relayId: Schema.String,
  /** A new app's first deploy, once its Relay has provisioned it. */
  awaitProvisioning: Schema.optionalKey(Schema.Boolean),
})
type DeployInput = typeof DeployInput.Type

/**
 * Deploys what an app's request asks when its turn comes (an ask, of any
 * kind, from `askAppDeploymentEffect`), holding its #deploy from sending
 * the deployment until its Relay says it ended, so the next waits its turn
 * behind it. The token that checks out a GitHub app's commit is made as
 * it's sent, and a reply lost to a restart is read back rather than sent
 * again: the Relay's current deployment of the app is this one, since only
 * this holds it.
 */
export const deployAppOperation = durableOperation({
  doing: () => "Deploying this App",
  input: DeployInput,
  kind: "app.deploy",
  locks: (input) => appDeploymentLocks(input.relayId, input.appId),
  // A failure ends it failed, so what it was for is asked again.
  run: (input, operation) =>
    deploySteps(input, operation.id).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : logException(Cause.squash(cause), {
              operation: "Apps.deploy",
              attributes: { "app.id": input.appId, "relay.id": input.relayId },
            })
      ),
      Effect.orDie
    ),
  version: 1,
})

const deploySteps = (input: DeployInput, id: string) =>
  Effect.gen(function* () {
    // A new app that never finished provisioning still takes its ask, so
    // none waits on it: refused, or nothing for one that's gone.
    let unready: "gone" | "waiting" | null = null
    if (input.awaitProvisioning) {
      for (let window = 0; ; window++) {
        const state = yield* Activity.make({
          name: `ready/${window}`,
          success: Schema.Literals(["ready", "waiting", "gone"]),
          execute: watchFor(
            provisioningState(input),
            (state) => state !== "waiting",
            () => followInterval
          ),
        })
        if (state === "ready") break
        if (state === "gone" || window + 1 >= provisionWindows) {
          unready = state
          break
        }
      }
    }
    // Taken only once its Relay is there to deploy it, so an ask made while
    // it's away waits for it, rather than failing.
    for (let window = 0; ; window++) {
      const reachable = yield* Activity.make({
        name: `relay/${window}`,
        success: Schema.Boolean,
        execute: watchFor(
          relayReachable(input.relayId),
          (reachable) => reachable,
          () => followIntervalLater
        ),
      })
      if (reachable) break
    }
    const plan = yield* Activity.make({
      name: "plan",
      success: Schema.NullOr(DeployPlan),
      execute: takeTurn(input, id, unready),
    })
    if (plan) yield* deployPlanned(input, plan)
  })

/**
 * Checks `check` every `every` until `done` says so, for up to a window,
 * returning what it last found.
 */
const watchFor = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (found: A) => boolean,
  every: () => Duration.Duration
) =>
  Effect.gen(function* () {
    const until =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(watchWindow)
    while (true) {
      const found = yield* check
      if (done(found) || (yield* Clock.currentTimeMillis) >= until) {
        return found
      }
      yield* Effect.sleep(every())
    }
  })

// Whether the app's Relay is enabled and connected.
const relayReachable = (relayId: string) =>
  listPersistedRelaysEffect().pipe(
    Effect.map((relays) =>
      relays.some(
        (relay) =>
          relay.id === relayId &&
          relay.enabled &&
          relayConnectionFeatures(relay.id).size > 0
      )
    ),
    Effect.catch(() => Effect.succeed(false))
  )

// Whether a new app is ready to deploy: provisioned, still provisioning,
// or gone or failed, when there's nothing to deploy.
const provisioningState = (input: DeployInput) =>
  Effect.gen(function* () {
    const relay = yield* enabledRelay(input.relayId)
    const app = yield* readRelayApp(relay, input.appId)
    if (app === null || app.provisioning?.phase === "failed") {
      return "gone" as const
    }
    return app.provisioning ? ("waiting" as const) : ("ready" as const)
  }).pipe(Effect.catch(() => Effect.succeed("waiting" as const)))

// Takes what the app's request asks and decides what that deploys, as one
// step: nothing for an app being deleted, which settles what was asked, so
// an ask after a deletion that failed or was kept starts afresh. Once it's
// taken, MySQL going away is waited out, and any other failure is recorded
// as a deployment, for whoever looks, so no ask taken is lost unseen; a
// poll's, every minute, is only logged.
const takeTurn = (
  input: DeployInput,
  id: string,
  unready: "gone" | "waiting" | null
) =>
  Effect.gen(function* () {
    const taken = yield* takeAppDeploymentRequestEffect(input.appId, id).pipe(
      Effect.retry({ schedule: whileMySqlIsAway })
    )
    if (!taken) return null
    const asked: AppDeploymentRequest = {
      appId: input.appId,
      relayId: input.relayId,
      trigger:
        taken.trigger === "push" || taken.trigger === "poll"
          ? taken.requestedBy
            ? "manual"
            : taken.trigger
          : taken.trigger,
      userId: taken.requestedBy,
    }
    let request = asked
    return yield* Effect.gen(function* () {
      const deletion = yield* findResourceDeletionEffect(
        input.relayId,
        "app",
        input.appId
      )
      if (
        unready === "gone" ||
        (deletion &&
          unfinishedDeletionStatuses.some(
            (status) => status === deletion.status
          ))
      ) {
        return null
      }
      if (unready === "waiting") {
        return yield* Effect.fail(
          new Error("The app was still being set up; deploy it once it's ready")
        )
      }
      const decided = yield* askedDeployment(input, taken)
      if (!decided) return null
      request = decided.request
      if (decided.refused) return yield* Effect.fail(decided.refused)
      // Its Relay joins the deployment to the databases it keeps for the
      // app, so it must have them first: Hearth's own step, in its lanes.
      const relay = yield* enabledRelay(input.relayId)
      yield* promiseEffect(() =>
        outsideOperation(() => ensureAppDatabaseConnectionsImported(relay))
      )
      const plan = yield* prepareAppDeploymentEffect(request, id)
      if (plan && request.trigger === "poll") {
        pollFailures.delete(`${input.relayId}:${input.appId}`)
      }
      return plan
    }).pipe(
      Effect.retry({
        schedule: whileMySqlIsAway,
        while: (cause) => cause instanceof DatabaseError,
      }),
      Effect.catchCause((cause) => {
        const failure = Cause.squash(cause)
        if (request.trigger !== "poll") {
          return recordRefusal(request, input.relayId, failure).pipe(
            Effect.as(null)
          )
        }
        const key = `${input.relayId}:${input.appId}`
        const message = errorMessage(failure)
        if (pollFailures.get(key) === message) return Effect.succeed(null)
        pollFailures.set(key, message)
        return logException(failure, {
          operation: "Apps.deploy.poll",
          attributes: { "app.id": input.appId, "relay.id": input.relayId },
        }).pipe(Effect.as(null))
      })
    )
  }).pipe(Effect.orDie)

/**
 * What an ask taken deploys. A person's builds even what's already live,
 * and deploys an update whatever its wait, while they may still manage the
 * app: one who no longer may is refused, though a push or poll that joined
 * their ask deploys as Kiln's own. A redeploy deploys its commit or digest
 * only while the app still deploys from what it came from. Nothing for an
 * app that no longer deploys from what Kiln asked of it.
 */
const askedDeployment = (input: DeployInput, taken: AppDeploymentRequestRow) =>
  Effect.gen(function* () {
    const app = yield* loadAppConfigEffect(input.relayId, input.appId)
    if (!app) return null
    const sourceType = app.config.sourceType
    const allowed =
      taken.requestedBy !== null && (yield* mayDeploy(input, taken.requestedBy))
    const automatic = taken.trigger === "push" || taken.trigger === "poll"
    // One who may no longer is refused, as who asked; a push or poll that
    // joined their ask is Kiln's own.
    const userId = allowed || !automatic ? taken.requestedBy : null
    const base = { appId: input.appId, relayId: input.relayId, userId }
    const pinned =
      taken.commitSha !== null && taken.commitSource !== null
        ? { commitSha: taken.commitSha, source: taken.commitSource }
        : undefined
    const request: AppDeploymentRequest = automatic
      ? {
          ...base,
          ...(taken.trigger === "push" && pinned && { pinned }),
          // Built even if live, for the person who asked.
          trigger: userId ? "manual" : taken.trigger,
        }
      : taken.trigger === "redeploy"
        ? {
            ...base,
            ...(taken.commitSha !== null && { commit: taken.commitSha }),
            ...(taken.imageDigest !== null && {
              imageDigest: taken.imageDigest,
            }),
            trigger: "redeploy",
          }
        : { ...base, trigger: taken.trigger }
    // Kiln's own asks of an app that deploys from elsewhere now.
    if (userId === null && automatic && sourceType !== "github") return null
    if (
      userId === null &&
      taken.trigger === "update" &&
      sourceType !== "image"
    ) {
      return null
    }
    const refused =
      userId !== null && !allowed
        ? new Error(
            "Whoever asked for this deployment may no longer manage the app"
          )
        : taken.trigger === "redeploy"
          ? yield* redeployGone(input, taken, app.config)
          : undefined
    return { refused, request }
  })

// Whether whoever asked may still manage the app, as their account stands.
const mayDeploy = (input: DeployInput, userId: string) =>
  (userId === developmentBypassUserId
    ? Effect.void
    : currentActingUser(userId, {
        email: "",
        emailVerified: false,
        id: userId,
        isDevelopmentBypass: false,
        name: "",
        role: "user",
        twoFactorEnabled: false,
      }).pipe(
        Effect.flatMap((user) =>
          promiseEffect(() =>
            requireRelayPermission({
              appId: input.appId,
              permission: "app.manage",
              relayId: input.relayId,
              user,
            })
          )
        )
      )
  ).pipe(
    Effect.as(true),
    // MySQL going away isn't a refusal; the turn waits it out.
    Effect.catch((cause) =>
      cause instanceof DatabaseError
        ? Effect.fail(cause)
        : Effect.succeed(false)
    )
  )

// Why a redeploy no longer applies: the app deploys from another
// repository or image than the deployment it redeploys.
const redeployGone = (
  input: DeployInput,
  taken: AppDeploymentRequestRow,
  config: AppConfig
) =>
  Effect.gen(function* () {
    if (taken.imageDigest !== null) {
      return config.sourceType === "image" && config.image === taken.imageSource
        ? undefined
        : new Error("The app deploys another image now; redeploy one of it")
    }
    if (taken.commitSha === null) return undefined
    // Its source names the repository of the deployment it redeploys.
    const source = yield* loadAppGitHubSourceEffect(input.appId)
    return config.sourceType === "github" &&
      source !== null &&
      source.repository === taken.commitSource
      ? undefined
      : new Error(
          "The app deploys from another repository now; redeploy one of its commits"
        )
  })

// Records the deployment, sends it, and follows it until its Relay says it
// ended, every step stored so a restart carries on where it was.
const deployPlanned = (input: DeployInput, plan: DeployPlan) =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: "record",
      execute: insertAppDeploymentEffect(runningRecord(plan, null)).pipe(
        Effect.retry({ schedule: whileMySqlIsAway }),
        Effect.tap(() =>
          Effect.sync(() => publishAppDeploymentChange(input.relayId))
        ),
        Effect.orDie
      ),
    })
    const sent = yield* relayCommand({
      name: "send",
      operation: "app.deploy",
      payload: plan.payload,
      recover: currentDeployment(input),
      relayId: input.relayId,
      sendPayload: asSent(plan),
      timeoutMs: 30_000,
    }).pipe(Effect.result)
    if (Result.isFailure(sent)) {
      yield* Activity.make({
        name: "refused",
        execute: finishPlanned(plan, {
          error: sent.failure.message,
          status: "failed",
        }),
      })
      return
    }
    const relayDeploymentId = yield* Activity.make({
      name: "accepted",
      success: Schema.NullOr(Schema.String),
      execute: Effect.gen(function* () {
        const parsed = relayAppSchema.safeParse(sent.success)
        const deploymentId = parsed.success
          ? (parsed.data.deployment?.id ?? null)
          : null
        if (deploymentId === null) {
          // A Relay that answers without its deployment can't be followed.
          yield* finishPlanned(plan, {
            error: "The Relay didn't report this deployment",
            status: "unknown",
          })
          return null
        }
        yield* recordRelayDeploymentEffect(plan.record.id, deploymentId).pipe(
          Effect.retry({ schedule: whileMySqlIsAway }),
          Effect.orDie
        )
        publishAppDeploymentChange(input.relayId)
        return deploymentId
      }),
    })
    if (relayDeploymentId === null) return
    const record = runningRecord(plan, relayDeploymentId)
    const started = Date.parse(record.startedAt)
    for (let window = 0; ; window++) {
      const ended = yield* Activity.make({
        name: `follow/${window}`,
        success: Schema.Boolean,
        // An unreachable Relay is asked again next time.
        execute: watchFor(
          checkAppDeploymentEffect(record).pipe(
            Effect.catch(() => Effect.succeed(false))
          ),
          (ended) => ended,
          () =>
            Date.now() - started < Duration.toMillis(followQuickly)
              ? followInterval
              : followIntervalLater
        ),
      })
      if (ended) break
    }
    // An app's updates follow what it runs now, by its current config.
    // Imported here, since image updates deploy through this module.
    yield* Activity.make({
      name: "recheck",
      execute: Effect.promise(
        () => import("@/lib/app-image-updates.server")
      ).pipe(
        Effect.map(({ recheckAppImage }) =>
          recheckAppImage(record.relayId, record.appId, record.triggeredBy)
        )
      ),
    })
  })

// The payload as it's sent: the app's saved configuration, read now, and a
// token made now to check out its commit.
const asSent = (plan: DeployPlan) =>
  Effect.gen(function* () {
    const app = yield* loadAppConfigEffect(
      plan.record.relayId,
      plan.record.appId
    ).pipe(Effect.mapError(sendError("app_config")))
    if (!app) {
      return yield* sendError("app_config")(new Error("App not found"))
    }
    // What was decided for one source doesn't deploy another.
    if (app.config.sourceType !== plan.record.sourceType) {
      return yield* sendError("app_config")(
        new Error("The app's source changed; deploy it again")
      )
    }
    const payload = { ...plan.payload, config: app.config }
    if (plan.token === null || payload.github === undefined) return payload
    const token = yield* checkoutToken(plan.token).pipe(
      Effect.mapError(sendError("github_token"))
    )
    return { ...payload, github: { ...payload.github, token } }
  })

const sendError = (code: string) => (cause: unknown) =>
  new RelayCommandError({
    code,
    message: errorMessage(cause),
    retryable: false,
  })

// What the reply to a send whose answer was lost would have said: the app
// as its Relay has it now, whose deployment is this one.
const currentDeployment = (input: DeployInput) =>
  Effect.gen(function* () {
    const relay = yield* enabledRelay(input.relayId)
    const app = yield* readRelayApp(relay, input.appId)
    if (!app?.deployment) {
      return yield* new RelayCommandError({
        code: "result_unavailable",
        message: "The Relay no longer has this deployment",
        retryable: false,
      })
    }
    return app as unknown
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RelayCommandError
        ? cause
        : new RelayCommandError({
            code: "unexpected",
            message: errorMessage(cause),
            retryable: false,
          })
    )
  )

// Records how a deployment that never ran on its Relay ended.
const finishPlanned = (
  plan: DeployPlan,
  outcome: { error: string; status: "failed" | "unknown" }
) =>
  Effect.gen(function* () {
    const finishedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const finished = yield* finishAppDeploymentEffect(plan.record.id, {
      ...outcome,
      finishedAt,
      rolling: null,
    }).pipe(Effect.retry({ schedule: whileMySqlIsAway }))
    if (!finished) return
    publishAppDeploymentChange(plan.record.relayId)
    yield* announceDeploymentEffect(runningRecord(plan, null), outcome.status)
  }).pipe(Effect.orDie)

/**
 * Asks an app to deploy, whatever asked: a push, a poll, an image update
 * found due, or a person's deploy, redeploy or update. The ask joins the
 * app's request, the newest winning, and a deployment is queued for it,
 * recorded too, so none is lost behind a deployment or across a restart:
 * every ask while the same deployments are ahead joins the one deployment,
 * which deploys the newest when its turn comes. A person's ask runs in
 * their operation, which refuses it while the app is replaced or removed.
 */
export const askAppDeploymentEffect = Effect.fn("Apps.deploy.ask")(
  function* (ask: {
    appId: string
    /** A new app's first deploy waits for its Relay to provision it. */
    awaitProvisioning?: boolean
    commit?: { sha: string; source: string }
    image?: { digest: string; source: string }
    relayId: string
    trigger: AppDeploymentAsk
    userId?: string | null
  }) {
    const acknowledged = yield* requestAppDeploymentEffect(ask)
    yield* queueRequestedDeployment(
      ask.appId,
      ask.relayId,
      acknowledged,
      ask.awaitProvisioning === true
    )
    publishAppDeploymentChange(ask.relayId)
  }
)

// The deployment that takes up an app's request past `acknowledged`.
const queueRequestedDeployment = (
  appId: string,
  relayId: string,
  acknowledged: number,
  awaitProvisioning = false
): Effect.Effect<string, unknown, Database> =>
  queueDurableOperation(
    deployAppOperation,
    { appId, relayId, ...(awaitProvisioning && { awaitProvisioning }) },
    {
      // One that failed leaves the request for another.
      again: true,
      idempotencyKey: `request:${relayId}/${appId}:${acknowledged}`,
    }
  )

/**
 * Every minute: queues what's asked and not yet deploying, as after a
 * restart; settles a deployment recorded as running that nothing follows,
 * as one from before deployments ran in lanes; and checks the branches of
 * apps whose source GitHub can't push to.
 */
export function startAppDeploymentPolling(): void {
  globalThis.kilnAppDeploymentPoller ??= forkAppWorker(
    Effect.gen(function* () {
      for (const record of yield* loadRunningAppDeploymentsEffect()) {
        // Its own operation follows it, while it runs.
        const operation = yield* loadOperation(record.id)
        if (operation?.state === "running" || operation?.state === "waiting") {
          continue
        }
        yield* checkAppDeploymentEffect(record).pipe(Effect.ignore)
      }
      for (const request of yield* loadAppDeploymentRequestsEffect()) {
        yield* queueRequestedDeployment(
          request.appId,
          request.relayId,
          request.acknowledgedRevision
        )
      }
      const sources = yield* loadAutoDeployGitHubSourcesEffect({
        polled: true,
      })
      for (const source of sources) {
        yield* askAppDeploymentEffect({
          appId: source.appId,
          relayId: source.relayId,
          trigger: "poll",
        })
      }
    }).pipe(
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), { operation: "Apps.deploy.poll" })
      ),
      Effect.repeat(Schedule.spaced(pollInterval)),
      Effect.asVoid
    )
  )
}

export function stopAppDeploymentPolling(): Promise<void> {
  const poller = globalThis.kilnAppDeploymentPoller
  globalThis.kilnAppDeploymentPoller = undefined
  return poller ? Effect.runPromise(Fiber.interrupt(poller)) : Promise.resolve()
}

if (import.meta.hot) import.meta.hot.dispose(() => stopAppDeploymentPolling())

/** Queues deployments of the apps a push to this branch reaches. */
export const deployPushedAppsEffect = Effect.fn("Apps.deploy.pushed")(
  function* (input: {
    branch: string
    /** The commit the push made its branch's head. */
    commitSha: string
    connectionId: string
    repositoryId: number
  }) {
    const sources = yield* loadAutoDeployGitHubSourcesEffect({
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
    })
    for (const source of sources) {
      if (source.branch === input.branch) {
        yield* askAppDeploymentEffect({
          appId: source.appId,
          commit: {
            sha: input.commitSha,
            source: `${input.repositoryId}/${input.branch}`,
          },
          relayId: source.relayId,
          trigger: "push",
        })
      }
    }
  }
)

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
