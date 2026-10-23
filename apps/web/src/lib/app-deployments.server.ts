import { randomUUID } from "node:crypto"

import {
  relayAppGitHubV1Feature,
  relayAppDeploymentLogSchema,
  relayAppImageUpdatesV1Feature,
  relayAppSchema,
  type AppConfig,
  type RelayApp,
  type RelayAppGitHubCheckout,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule, Semaphore } from "effect"

import {
  finishAppDeploymentEffect,
  insertAppDeploymentEffect,
  latestAppDeploymentsEffect,
  loadAppGitHubSourceEffect,
  loadAutoDeployGitHubSourcesEffect,
  loadRunningAppDeploymentsEffect,
  type AppDeploymentRecord,
  type AppDeploymentStatus,
  type AppDeploymentTrigger,
} from "@/effect/app-deployments"
import {
  autoUpdateAt,
  claimImageUpdateEffect,
  loadAppImageUpdateEffect,
} from "@/effect/app-image-updates"
import { ExternalServiceError } from "@/effect/errors"
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
import { forkAppWorker } from "@/effect/runtime"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"

// Deploys apps and records each deployment: Hearth resolves what a GitHub
// app builds, sends it to the app's Relay, and follows the deployment there
// until it ends. Pushes and polls queue deployments per app, so a burst of
// commits deploys the newest once the running one finishes.

const pollInterval = "1 minute"
// How often a running deployment is checked on its Relay, and for how long.
const followInterval = "2 seconds"
const followLimitMs = 2 * 60 * 60_000
// How long a new app may take to provision before its first deployment.
const provisionLimitMs = 10 * 60_000

export interface AppDeploymentRequest {
  appId: string
  /** A commit to build again; otherwise the head of the app's branch. */
  commit?: string
  /** An image digest to deploy again, as a rollback of an image update. */
  imageDigest?: string
  relayId: string
  trigger: AppDeploymentTrigger
  /** Who asked, for the record and the Relay's audit; null for automation. */
  userId: string | null
  /** Started where nobody sees its failure, which is recorded instead. */
  background?: boolean
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
 * Starts a deployment of the app's saved configuration and records it.
 * A push or poll for the branch head the app last tried deploys nothing,
 * and returns null, so a failing commit or a rollback isn't redeployed
 * every minute; nor does a poll while the Relay is offline, which checks
 * again once it's back. An image update deploys the digest Kiln found its
 * tag naming; one Kiln starts on its own deploys nothing, either, unless
 * it's still due when its turn comes.
 */
export const startAppDeploymentEffect = Effect.fn("Apps.deploy")(function* (
  request: AppDeploymentRequest
) {
  yield* Effect.annotateCurrentSpan({
    "app.id": request.appId,
    "app.deployment.trigger": request.trigger,
    "relay.id": request.relayId,
  })
  const relay = yield* enabledRelay(request.relayId)
  const automatic = request.trigger === "push" || request.trigger === "poll"
  const autoUpdate = request.trigger === "update" && request.userId === null
  // Nobody watches these, so a refusal is recorded instead.
  const unattended = automatic || autoUpdate || request.background === true
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
      ? yield* imageUpdateDigest(relay, app.config, request)
      : request.imageDigest
  if (imageDigest === null) return null
  const prepared =
    app.config.sourceType === "github"
      ? yield* githubCommit(relay, request).pipe(
          // A push or a deploy waiting on provisioning that fails before it
          // knows its commit, as when the branch is gone, is recorded; a
          // poll would record it every minute, so it isn't.
          Effect.tapError((cause) =>
            request.trigger === "push" || request.background
              ? recordRefusal(request, relay.id, cause)
              : Effect.void
          )
        )
      : undefined
  if (prepared === null) return null
  const github = prepared ?? null
  // A commit deployed again, as a rollback, holds until a new one lands.
  if (github && automatic) {
    const { head } = yield* latestAppDeploymentsEffect(request.appId)
    if (head?.commitSha === github.commit.sha) return null
  }
  const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const base = {
    appId: request.appId,
    branch: github?.source.branch ?? null,
    commitAuthor: github?.commit.author ?? null,
    commitMessage: github?.commit.message ?? null,
    commitSha: github?.commit.sha ?? null,
    id: randomUUID(),
    imageDigest: imageDigest ?? null,
    relayId: relay.id,
    repository: github?.source.repository ?? null,
    sourceType: app.config.sourceType,
    startedAt,
    trigger: request.trigger,
    triggeredBy: request.userId,
  }
  const deploy = Effect.gen(function* () {
    // Minted only once there's something to deploy.
    const checkout: RelayAppGitHubCheckout | null = github
      ? {
          build: github.source.build,
          commit: github.commit.sha,
          path: github.source.path,
          repository: github.source.repository,
          token: yield* github.token,
        }
      : null
    const response = yield* Effect.tryPromise({
      try: () =>
        relayRpc(
          relay,
          "app.deploy",
          {
            appId: request.appId,
            config: app.config,
            ...(checkout && { github: checkout }),
            ...(imageDigest && { imageDigest }),
            name: app.name,
          },
          30_000,
          request.userId ?? undefined
        ),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("The Relay refused it"),
    })
    return relayAppSchema.parse(response)
  })
  const deployed: RelayApp = yield* deploy.pipe(
    // Nobody watches a push, poll, update Kiln started, or deploy waiting
    // on provisioning, so its refusal is recorded instead.
    Effect.tapError((cause) =>
      unattended
        ? insertAppDeploymentEffect({
            ...base,
            error: cause instanceof Error ? cause.message : String(cause),
            finishedAt: startedAt,
            relayDeploymentId: null,
            rolling: null,
            status: "failed",
          }).pipe(
            Effect.andThen(
              Effect.sync(() => publishAppDeploymentChange(relay.id))
            ),
            Effect.andThen(announceDeploymentEffect(base, "failed")),
            Effect.ignore
          )
        : Effect.void
    )
  )
  const relayDeploymentId = deployed.deployment?.id ?? null
  const record: AppDeploymentRecord = {
    ...base,
    // A Relay that answers without its deployment can't be followed.
    error: relayDeploymentId ? null : "The Relay didn't report this deployment",
    finishedAt: relayDeploymentId ? null : startedAt,
    relayDeploymentId,
    rolling: null,
    status: relayDeploymentId ? "running" : "unknown",
  }
  yield* insertAppDeploymentEffect(record)
  publishAppDeploymentChange(relay.id)
  followAppDeployment(record)
  return { app: deployed, deployment: record }
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
    Effect.tap(insertAppDeploymentEffect),
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
      yield* resolveAppImageUpdateNotificationsEffect(record.appId, {
        installedDigest: record.imageDigest,
      })
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
// and how to get a token that reads only its repository.
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
    request.commit ?? source.branch
  )
  return {
    commit,
    source,
    token: githubRepositoryReadTokenEffect(
      credentials,
      installation.id,
      source.repositoryId
    ),
  }
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
  request: AppDeploymentRequest
) {
  if (!relayConnectionFeatures(relay.id).has(relayAppImageUpdatesV1Feature)) {
    return yield* Effect.fail(
      new Error("Update this Relay to deploy image updates")
    )
  }
  const update = yield* loadAppImageUpdateEffect(request.appId)
  const digest =
    config.sourceType === "image" &&
    update?.state === "available" &&
    update.image === config.image
      ? update.latestDigest
      : null
  if (request.userId !== null) {
    if (digest === null) {
      return yield* Effect.fail(new Error("There's no update to deploy"))
    }
    // Someone asked: it deploys whatever came of it before, and an
    // automatic update won't try it again.
    yield* claimImageUpdateEffect(request.appId, digest)
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
  return (yield* claimImageUpdateEffect(request.appId, digest)) ? digest : null
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
  var kilnAppDeploymentFollowed: Set<string> | undefined
  var kilnAppDeploymentLocks: Map<string, Semaphore.Semaphore> | undefined
  var kilnAppDeploymentQueued: Set<string> | undefined
  var kilnAppDeploymentPollFailures: Map<string, string> | undefined
  var kilnAppDeploymentPoller: Fiber.Fiber<void> | undefined
}

const followed = (globalThis.kilnAppDeploymentFollowed ??= new Set())
const deployLocks = (globalThis.kilnAppDeploymentLocks ??= new Map())
const queued = (globalThis.kilnAppDeploymentQueued ??= new Set())
// Each polled app's last failure, reported once.
const pollFailures = (globalThis.kilnAppDeploymentPollFailures ??= new Map())

/** Checks a running deployment until it ends, once per process. */
export function followAppDeployment(record: AppDeploymentRecord): void {
  if (!record.relayDeploymentId || followed.has(record.id)) return
  followed.add(record.id)
  forkAppWorker(
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + followLimitMs
      while ((yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.sleep(followInterval)
        const settled = yield* checkAppDeploymentEffect(record).pipe(
          // An unreachable Relay is checked again next time.
          Effect.catch(() => Effect.succeed(false))
        )
        if (!settled) continue
        // An app's updates follow what it runs now, by its current config:
        // one that deploys from elsewhere now has none on offer. Imported
        // here, since image updates deploy through this module.
        const { recheckAppImage } = yield* Effect.promise(
          () => import("@/lib/app-image-updates.server")
        )
        recheckAppImage(record.relayId, record.appId, record.triggeredBy)
        return
      }
    }).pipe(
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), {
          operation: "Apps.deployment.follow",
          attributes: { "app.deployment.id": record.id },
        })
      ),
      Effect.ensuring(Effect.sync(() => followed.delete(record.id)))
    )
  )
}

/**
 * Deploys an app's branch head after a push or poll, or its image update,
 * one deployment at a time per app. A trigger arriving while one waits
 * joins it: the waiting one deploys whatever is newest when it runs.
 */
export function enqueueAppDeployment(
  appId: string,
  relayId: string,
  trigger: "poll" | "push" | "update"
): void {
  const key = `${relayId}:${appId}`
  if (queued.has(key)) return
  queued.add(key)
  const lock = deployLocks.get(key) ?? Semaphore.makeUnsafe(1)
  deployLocks.set(key, lock)
  forkAppWorker(
    lock.withPermit(
      Effect.sync(() => queued.delete(key)).pipe(
        Effect.andThen(awaitRunningDeployment(appId)),
        Effect.andThen(
          startAppDeploymentEffect({ appId, relayId, trigger, userId: null })
        ),
        Effect.asVoid,
        // A poll that succeeds clears its app's last failure.
        Effect.tap(() => Effect.sync(() => pollFailures.delete(key))),
        Effect.catchCause((cause) => {
          const failure = Cause.squash(cause)
          // A failing poll fails again every minute, so only a new failure
          // reaches telemetry, until a poll gets through.
          if (trigger === "poll") {
            const message = errorMessage(failure)
            if (pollFailures.get(key) === message) return Effect.void
            pollFailures.set(key, message)
          }
          return logException(failure, {
            operation: `Apps.deploy.${trigger}`,
            attributes: { "app.id": appId, "relay.id": relayId },
          })
        })
      )
    )
  )
}

// Waits, up to an hour, for the app's running deployment to end, so a push
// doesn't fail because one is already running.
const awaitRunningDeployment = (appId: string) =>
  latestAppDeploymentsEffect(appId).pipe(
    Effect.map(({ latest }) => latest?.status === "running"),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      times: 1_200,
      while: (running) => running,
    }),
    Effect.asVoid
  )

/**
 * Every minute: resumes following deployments a restart left running, and
 * checks the branches of apps whose source GitHub can't push to.
 */
export function startAppDeploymentPolling(): void {
  globalThis.kilnAppDeploymentPoller ??= forkAppWorker(
    Effect.gen(function* () {
      for (const record of yield* loadRunningAppDeploymentsEffect()) {
        followAppDeployment(record)
      }
      const sources = yield* loadAutoDeployGitHubSourcesEffect({
        polled: true,
      })
      for (const source of sources) {
        enqueueAppDeployment(source.appId, source.relayId, "poll")
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

/**
 * Deploys now, or, for an app its Relay is still provisioning, once it's
 * ready, as when an app is created from GitHub. Null when it waits.
 */
export const startAppDeploymentWhenReadyEffect = Effect.fn(
  "Apps.deploy.whenReady"
)(function* (request: AppDeploymentRequest) {
  const relay = yield* enabledRelay(request.relayId)
  const app = yield* readRelayApp(relay, request.appId)
  if (app && !app.provisioning) {
    return yield* startAppDeploymentEffect(request)
  }
  forkAppWorker(
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + provisionLimitMs
      while ((yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.sleep(followInterval)
        const current = yield* readRelayApp(relay, request.appId).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        // Gone, or its provisioning failed: nothing to deploy.
        if (current === null || current?.provisioning?.phase === "failed") {
          return
        }
        if (current && !current.provisioning) {
          yield* startAppDeploymentEffect({ ...request, background: true })
          return
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), {
          operation: "Apps.deploy.whenReady",
          attributes: { "app.id": request.appId },
        })
      )
    )
  )
  return null
})

/** Queues deployments of the apps a push to this branch reaches. */
export const deployPushedAppsEffect = Effect.fn("Apps.deploy.pushed")(
  function* (input: {
    branch: string
    connectionId: string
    repositoryId: number
  }) {
    const sources = yield* loadAutoDeployGitHubSourcesEffect({
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
    })
    for (const source of sources) {
      if (source.branch === input.branch) {
        enqueueAppDeployment(source.appId, source.relayId, "push")
      }
    }
  }
)

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
