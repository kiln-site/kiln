import {
  appConfigSchema,
  relayAppDeploymentLogSchema,
  relayAppGitHubV1Feature,
  type AppGitHubBuild,
  type RelayAppDeploymentLog,
} from "@workspace/contracts"

import {
  autoUpdateAt,
  currentImageUpdate,
  defaultAppImageUpdatePolicy,
  loadAppImageUpdateEffect,
  type AppImageUpdate,
} from "@/effect/app-image-updates"
import {
  latestAppDeploymentsEffect,
  listAppDeploymentsEffect,
  loadAppDeploymentEffect,
  loadRunningAppDeploymentsEffect,
  loadAppGitHubSourceEffect,
  saveAppGitHubSourceEffect,
  type AppDeploymentRecord,
  type AppGitHubSource,
} from "@/effect/app-deployments"
import {
  getGitHubFileEffect,
  getGitHubRepositoryEffect,
  githubInstallationTokenEffect,
} from "@/effect/github-api"
import {
  loadGitHubConnectionCredentialEffect,
  loadGitHubConnectionsEffect,
} from "@/effect/github-sync"
import {
  listAppRecordsEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  appDeployKey,
  askAppDeploymentEffect,
  deployAppKind,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import { cancelQueuedOperation } from "@/operations/durable"
import { activeOperations, waitingOperation } from "@/operations/records"
import { runOperationPromise } from "@/operations/operation"
import { askAppDeploy } from "@/server/app-deploy-ask.server"
import { publishGitHubSyncChange } from "@/lib/github-sync.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  authorizedApp,
  authorizedAppFor,
  hasAppPermission,
} from "@/server/app-access"
import { requireEligibleResourceUser } from "@/server/auth"
import { connectionToken } from "@/server/github-sync.server"
import { databaseRpc } from "@/server/managed-database-access"

// Deployments as the Deployments page and an app's rail show them, and the
// GitHub repository an app deploys from.

const deploymentPageSize = 100

export interface AppDeploymentView extends AppDeploymentRecord {
  appName: string
  /** Who may redeploy it and read its log. */
  canManage: boolean
  canReadLogs: boolean
  commitUrl: string | null
  relayName: string
  /** The person who deployed, by name; null for pushes and polls. */
  triggeredByName: string | null
}

export interface AppGitHubSourceView {
  autoDeploy: boolean
  branch: string
  build: AppGitHubBuild
  /** Null once the source was removed from Kiln. */
  connectionId: string | null
  connectionName: string | null
  path: string
  repository: string
  repositoryUrl: string
}

export async function getAppDeploymentsHandler(data: {
  appId?: string
  before?: { id: string; startedAt: string }
  relayId?: string
}) {
  const user = await requireEligibleResourceUser()
  const [relays, grants, apps] = await Promise.all([
    listPersistedRelays(),
    isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
    runAppEffect("apps.directory", listAppRecordsEffect()),
  ])
  const relayNames = new Map(
    relays
      .filter(
        (relay) => relay.enabled && (!data.relayId || relay.id === data.relayId)
      )
      .map((relay) => [relay.id, relay.name])
  )
  // Every app on a Relay the person reads apps on, and the apps they own
  // elsewhere.
  const relayIds = [...relayNames.keys()].filter((relayId) =>
    hasAppPermission(user, grants, { relayId }, "app.read")
  )
  const records = await runAppEffect(
    "apps.deployments.list",
    listAppDeploymentsEffect({
      appId: data.appId,
      appIds: apps.flatMap((app) =>
        relayNames.has(app.relayId) &&
        !relayIds.includes(app.relayId) &&
        hasAppPermission(user, grants, app, "app.read")
          ? [app.appId]
          : []
      ),
      before: data.before,
      limit: deploymentPageSize + 1,
      relayIds,
    })
  )
  const page = records.slice(0, deploymentPageSize)
  const appNames = new Map(apps.map((app) => [app.appId, app.name]))
  const people = await runAppEffect(
    "apps.deployments.people",
    attachRelayOwnersEffect(
      page.map((record) => ({ createdBy: record.triggeredBy })),
      false
    )
  )
  const last = page.at(-1)
  return {
    items: page.map((record, index): AppDeploymentView => ({
      ...record,
      appName: appNames.get(record.appId) ?? record.appId.slice(0, 8),
      canManage: hasAppPermission(user, grants, record, "app.manage"),
      canReadLogs: hasAppPermission(user, grants, record, "app.logs.read"),
      commitUrl: commitUrl(record),
      relayName: relayNames.get(record.relayId) ?? "Relay",
      triggeredByName: record.triggeredBy
        ? record.triggeredBy === user.id
          ? (user.name ?? user.email)
          : (people[index]?.ownerName ?? "Deleted user")
        : null,
    })),
    nextCursor:
      records.length > deploymentPageSize && last
        ? { id: last.id, startedAt: last.startedAt }
        : null,
  }
}

/**
 * Each app the person can read that has a deploy waiting its turn, or one
 * Hearth is running, so its Deploy button says so from the moment it's
 * asked. A waiting one names its operation, to cancel it.
 */
export async function getAppDeployStatesHandler(user: AuthenticatedUser) {
  const [active, running] = await Promise.all([
    runAppEffect("apps.deploy.active", activeOperations(deployAppKind)),
    runAppEffect("apps.deployments.running", loadRunningAppDeploymentsEffect()),
  ])
  if (active.length === 0 && running.length === 0) return {}
  const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
  const states: Record<
    string,
    { deploying: boolean; queuedId: string | null }
  > = {}
  const readable = (app: { appId: string; relayId: string }) =>
    hasAppPermission(user, grants, app, "app.read")
  for (const record of running) {
    if (!readable(record)) continue
    states[record.appId] = { deploying: true, queuedId: null }
  }
  // Running from when it starts, before its Relay hears of it.
  for (const { id, input, state } of active) {
    const { appId, relayId } = input as { appId?: string; relayId?: string }
    if (!relayId || !appId || !readable({ appId, relayId })) continue
    const known = states[appId]
    states[appId] = {
      deploying: (known?.deploying ?? false) || state === "running",
      queuedId: state === "waiting" ? id : (known?.queuedId ?? null),
    }
  }
  return states
}

/**
 * Cancels the app's deploy still waiting its turn, the one shown: what's
 * asked after it queues anew.
 */
export async function cancelQueuedAppDeployHandler(
  user: AuthenticatedUser,
  data: { appId: string; operationId: string; relayId: string }
) {
  const { relay } = await authorizedAppFor(user, data, "app.manage")
  const waiting = await runAppEffect(
    "apps.deploy.waiting",
    waitingOperation(deployAppKind, appDeployKey(relay.id, data.appId))
  )
  const cancelled =
    waiting?.id === data.operationId &&
    (await runAppEffect(
      "apps.deploy.cancel",
      cancelQueuedOperation(waiting.id)
    ))
  publishAppDeploymentChange(relay.id)
  if (!cancelled) throw new Error("That deploy has already started")
  return { cancelled: true as const }
}

/** What the app's rail shows: where it deploys from and what it runs. */
export async function getAppDeploymentSummaryHandler(data: {
  appId: string
  relayId: string
}) {
  const { app, user } = await authorizedApp(data, "app.read")
  const [source, latest, imageUpdate] = await Promise.all([
    runAppEffect("apps.github.source", loadAppGitHubSourceEffect(data.appId)),
    runAppEffect(
      "apps.deployments.latest",
      latestAppDeploymentsEffect(data.appId)
    ),
    app.config.sourceType === "image"
      ? runAppEffect(
          "apps.imageUpdates.load",
          loadAppImageUpdateEffect(data.appId)
        )
      : null,
  ])
  const view = source ? await sourceView(user, source) : null
  return {
    current: latest.succeeded && {
      ...latest.succeeded,
      commitUrl: commitUrl(latest.succeeded),
    },
    latest: latest.latest && {
      ...latest.latest,
      commitUrl: commitUrl(latest.latest),
    },
    // An app switched to another source keeps its repository, unused, for
    // its Source dialog to switch back to.
    savedSource: view,
    source: app.config.sourceType === "github" ? view : null,
    // What the app deploys from now, which its last deployment may not show.
    sourceType: app.config.sourceType,
    // Nothing to check until it names an image.
    imageUpdates:
      app.config.sourceType === "image" && app.config.image !== ""
        ? imageUpdatesView(
            app.config.image,
            imageUpdate,
            currentImageUpdate(
              imageUpdate,
              app.config.image,
              latest.latest?.startedAt ?? null
            )
          )
        : null,
  }
}

/**
 * What an image app's Deployment card shows of its updates. Only what the
 * last check found for the image its config names now; one saved since
 * hasn't been checked.
 */
// The app's saved policy, and what the last check found, if it still
// describes the app (`currentImageUpdate`).
function imageUpdatesView(
  image: string,
  saved: AppImageUpdate | null,
  current: AppImageUpdate | null
) {
  const policy = {
    delayHours: saved?.delayHours ?? defaultAppImageUpdatePolicy.delayHours,
    mode: saved?.mode ?? defaultAppImageUpdatePolicy.mode,
  }
  // A digest never moves, so there's nothing to check.
  const pinned = image.includes("@")
  return {
    ...policy,
    autoUpdateAt: current && autoUpdateAt(current),
    checkError: current?.checkError ?? null,
    checkedAt: current?.checkedAt ?? null,
    image,
    latestDigest: current?.latestDigest ?? null,
    latestSeenAt: current?.latestSeenAt ?? null,
    pinned,
    runningDigest: current?.runningDigest ?? null,
    skippedDigest: current?.skippedDigest ?? null,
    state: pinned ? null : (current?.state ?? null),
  }
}

/**
 * The Dockerfile or Compose file a GitHub app deploys, at its branch's
 * head, for anyone who can read the app. Only that file: the path comes
 * from the app's source, never the request.
 */
export async function getAppGitHubSourceFileHandler(data: {
  appId: string
  relayId: string
}) {
  const { app } = await authorizedApp(data, "app.read")
  const source =
    app.config.sourceType === "github"
      ? await runAppEffect(
          "apps.github.source",
          loadAppGitHubSourceEffect(data.appId)
        )
      : null
  if (!source) throw new Error("This app doesn't deploy from GitHub")
  if (!source.connectionId) {
    throw new Error("The app's GitHub source was removed; choose another")
  }
  const connection = await runAppEffect(
    "github.connection.credential",
    loadGitHubConnectionCredentialEffect({ id: source.connectionId })
  )
  const installation = connection.installation
  if (!installation || installation.suspended) {
    throw new Error("The GitHub App can't read this repository")
  }
  const token = await runAppEffect(
    "github.app.installationToken",
    githubInstallationTokenEffect(
      { appId: connection.appId, privateKey: connection.privateKey },
      installation.id
    )
  )
  const content = await runAppEffect(
    "github.file.get",
    getGitHubFileEffect(
      token,
      source.repository,
      source.path,
      source.branch,
      appSourceFileMaxBytes[source.build]
    )
  )
  return {
    branch: source.branch,
    content,
    path: source.path,
    url: `https://github.com/${source.repository}/blob/${source.branch
      .split("/")
      .map(encodeURIComponent)
      .join("/")}/${source.path.split("/").map(encodeURIComponent).join("/")}`,
  }
}

// As large as the app's own Dockerfile and Compose file may be.
const appSourceFileMaxBytes: Record<AppGitHubBuild, number> = {
  compose: 400_000,
  dockerfile: 200_000,
}

/**
 * Points the app at a repository and makes it the app's source. Saving one
 * needs the source's owner, or an administrator, like a sync.
 */
export async function saveAppGitHubSourceHandler(
  user: AuthenticatedUser,
  data: {
    appId: string
    autoDeploy: boolean
    branch: string
    build: AppGitHubBuild
    connectionId: string
    deploy: boolean
    path: string
    relayId: string
    repository: string
  }
) {
  const { relay } = await authorizedAppFor(user, data, "app.manage")
  if (!relayConnectionFeatures(relay.id).has(relayAppGitHubV1Feature)) {
    throw new Error(
      relayConnectionFeatures(relay.id).size === 0
        ? "The Relay is offline"
        : "Update this Relay to deploy apps from GitHub"
    )
  }
  const token = await connectionToken(user, data.connectionId)
  // The repository's ID survives renames, so pushes match it after one.
  const repository = await runAppEffect(
    "github.repository.get",
    getGitHubRepositoryEffect(token, data.repository)
  )
  await runAppEffect(
    "apps.github.source.save",
    saveAppGitHubSourceEffect({
      appId: data.appId,
      autoDeploy: data.autoDeploy,
      branch: data.branch,
      build: data.build,
      connectionId: data.connectionId,
      createdBy: user.id,
      path: data.path,
      repository: repository.full_name,
      repositoryId: repository.id,
    })
  )
  const config = await runAppEffect(
    "apps.config.save",
    updateAppConfigEffect(relay.id, data.appId, (current) =>
      appConfigSchema.parse({ ...current, sourceType: "github" })
    )
  )
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relay.id] },
    scope: { relayId: relay.id },
    topics: ["apps", "app-deployments"],
    type: "hearth.invalidate",
  })
  // Sources count the apps that deploy from them.
  publishGitHubSyncChange()
  // Queued, behind any deployment running; a new app may still be
  // provisioning, and deploys once it's ready.
  if (data.deploy) {
    await runAppEffect(
      "apps.deploy",
      askAppDeploymentEffect({
        appId: data.appId,
        awaitProvisioning: true,
        relayId: relay.id,
        trigger: "manual",
        userId: user.id,
      })
    )
  }
  return { config, queued: data.deploy === true }
}

/**
 * Deploys a past deployment's commit or digest again, or the app's config,
 * queued behind any deployment running.
 */
export async function redeployAppDeploymentHandler(
  user: AuthenticatedUser,
  data: { deploymentId: string }
) {
  const record = await recordFor(data.deploymentId)
  const { app, relay } = await authorizedAppFor(user, record, "app.manage")
  // A commit only of the repository the app deploys from now, which its
  // deployment names, and again once its turn comes.
  if (record.commitSha) {
    const source = await runAppEffect(
      "apps.github.source",
      loadAppGitHubSourceEffect(record.appId)
    )
    if (
      app.config.sourceType !== "github" ||
      source?.repository !== record.repository
    ) {
      throw new Error(
        "This deployment was of another repository; redeploy one of the app's own"
      )
    }
  }
  return runOperationPromise(
    askAppDeploy,
    {
      appId: record.appId,
      ...(record.commitSha && {
        commit: { sha: record.commitSha, source: record.repository ?? "" },
      }),
      ...(record.imageDigest && {
        image: { digest: record.imageDigest, source: app.config.image },
      }),
      relayId: relay.id,
      trigger: "redeploy",
    },
    { user }
  )
}

/** A deployment's log, from its Relay while it keeps it. */
export async function getAppDeploymentLogHandler(data: {
  deploymentId: string
}): Promise<{ log: RelayAppDeploymentLog; reason: string | null }> {
  const record = await recordFor(data.deploymentId)
  const { relay, user } = await authorizedApp(record, "app.logs.read")
  if (!record.relayDeploymentId) {
    return { log: null, reason: "The Relay refused this deployment" }
  }
  const features = relayConnectionFeatures(relay.id)
  if (!features.has(relayAppGitHubV1Feature)) {
    return {
      log: null,
      reason:
        features.size === 0
          ? "The Relay is offline"
          : "Update this Relay to read past logs",
    }
  }
  const log = relayAppDeploymentLogSchema.parse(
    await databaseRpc(
      relay,
      "app.deployment.read",
      { appId: record.appId, deploymentId: record.relayDeploymentId },
      15_000,
      user.id
    )
  )
  return {
    log,
    reason: log ? null : "The Relay keeps only each app's 20 latest logs",
  }
}

export async function recordFor(deploymentId: string) {
  const record = await runAppEffect(
    "apps.deployment.load",
    loadAppDeploymentEffect(deploymentId)
  )
  if (!record) throw new Error("Deployment not found")
  return record
}

async function sourceView(
  user: AuthenticatedUser,
  source: AppGitHubSource
): Promise<AppGitHubSourceView> {
  const connections = await runAppEffect(
    "github.connections.load",
    loadGitHubConnectionsEffect()
  )
  const connection = connections.find(
    (candidate) => candidate.id === source.connectionId
  )
  // Only its owner and administrators see whose source it is.
  const visible =
    connection && (isPlatformAdmin(user) || connection.ownerUserId === user.id)
  return {
    autoDeploy: source.autoDeploy,
    branch: source.branch,
    build: source.build,
    connectionId: source.connectionId,
    connectionName: connection
      ? visible
        ? (connection.installation?.accountLogin ?? connection.appName)
        : "GitHub"
      : null,
    path: source.path,
    repository: source.repository,
    repositoryUrl: `https://github.com/${source.repository}`,
  }
}

function commitUrl(record: AppDeploymentRecord): string | null {
  return record.repository && record.commitSha
    ? `https://github.com/${record.repository}/commit/${record.commitSha}`
    : null
}
