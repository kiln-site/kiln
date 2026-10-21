import {
  appConfigSchema,
  relayAppDeploymentLogSchema,
  relayAppGitHubV1Feature,
  type AppGitHubBuild,
  type RelayAppDeploymentLog,
} from "@workspace/contracts"

import {
  latestAppDeploymentsEffect,
  listAppDeploymentsEffect,
  loadAppDeploymentEffect,
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
import { listAppRecordsEffect, updateAppConfigEffect } from "@/effect/managed-apps"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  publishAppDeploymentChange,
  startAppDeploymentEffect,
  startAppDeploymentWhenReadyEffect,
} from "@/lib/app-deployments.server"
import { publishGitHubSyncChange } from "@/lib/github-sync.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { authorizedApp, hasAppPermission } from "@/server/app-access"
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
        (relay) =>
          relay.enabled &&
          (!data.relayId || relay.id === data.relayId) &&
          hasAppPermission(user, grants, relay.id, "app.read")
      )
      .map((relay) => [relay.id, relay.name])
  )
  const records = await runAppEffect(
    "apps.deployments.list",
    listAppDeploymentsEffect({
      appId: data.appId,
      before: data.before,
      limit: deploymentPageSize + 1,
      relayIds: [...relayNames.keys()],
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
    items: page.map(
      (record, index): AppDeploymentView => ({
        ...record,
        appName: appNames.get(record.appId) ?? record.appId.slice(0, 8),
        canManage: hasAppPermission(
          user,
          grants,
          record.relayId,
          "app.manage"
        ),
        canReadLogs: hasAppPermission(
          user,
          grants,
          record.relayId,
          "app.logs.read"
        ),
        commitUrl: commitUrl(record),
        relayName: relayNames.get(record.relayId) ?? "Relay",
        triggeredByName: record.triggeredBy
          ? record.triggeredBy === user.id
            ? (user.name ?? user.email)
            : (people[index]?.ownerName ?? "Deleted user")
          : null,
      })
    ),
    nextCursor:
      records.length > deploymentPageSize && last
        ? { id: last.id, startedAt: last.startedAt }
        : null,
  }
}

/** What the app's rail shows: where it deploys from and what it runs. */
export async function getAppDeploymentSummaryHandler(data: {
  appId: string
  relayId: string
}) {
  const { app, user } = await authorizedApp(data, "app.read")
  const [source, latest] = await Promise.all([
    runAppEffect(
      "apps.github.source",
      loadAppGitHubSourceEffect(data.appId)
    ),
    runAppEffect(
      "apps.deployments.latest",
      latestAppDeploymentsEffect(data.appId)
    ),
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
export async function saveAppGitHubSourceHandler(data: {
  appId: string
  autoDeploy: boolean
  branch: string
  build: AppGitHubBuild
  connectionId: string
  deploy: boolean
  path: string
  relayId: string
  repository: string
}) {
  const { relay, user } = await authorizedApp(data, "app.manage")
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
  // A new app may still be provisioning; it deploys once it's ready.
  const deployed = data.deploy
    ? await runAppEffect(
        "apps.deploy",
        startAppDeploymentWhenReadyEffect({
          appId: data.appId,
          relayId: relay.id,
          trigger: "manual",
          userId: user.id,
        })
      )
    : null
  return { config, deployment: deployed?.deployment ?? null }
}

/** Deploys a past deployment's commit again, or the app's config. */
export async function redeployAppDeploymentHandler(data: {
  deploymentId: string
}) {
  const record = await recordFor(data.deploymentId)
  const { relay, user } = await authorizedApp(record, "app.manage")
  const started = await runAppEffect(
    "apps.redeploy",
    startAppDeploymentEffect({
      appId: record.appId,
      commit: record.commitSha ?? undefined,
      relayId: relay.id,
      trigger: "redeploy",
      userId: user.id,
    })
  )
  publishAppDeploymentChange(relay.id)
  return { deployment: started?.deployment ?? null }
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

async function recordFor(deploymentId: string) {
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
