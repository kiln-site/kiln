import {
  appConfigSchema,
  relayAppGitHubV1Feature,
  relayDeploymentLogSchema,
  type AppGitHubBuild,
  type RelayDeploymentLog,
  type RelayDeploymentRead,
} from "@workspace/contracts"

import {
  currentBrickUpdate,
  currentImageUpdate,
  loadInstanceUpdateEffect,
} from "@/effect/instance-updates"
import { updatesView } from "@/server/instance-updates.server"
import {
  listTunnelRecordsEffect,
  requireTunnelPermission,
} from "@/server/tunnel-access.server"
import {
  latestAppDeploymentsEffect,
  listDeploymentsEffect,
  loadAppDeploymentEffect,
  loadDeploymentEffect,
  loadRunningAppDeploymentsEffect,
  loadAppGitHubSourceEffect,
  saveAppGitHubSourceEffect,
  type AppDeploymentRecord,
  type AppGitHubSource,
  type DatabaseDeploymentRecord,
  type DeploymentKind,
  type DeploymentRecord,
  type ServerDeploymentRecord,
  type TunnelDeploymentRecord,
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
import { listManagedDatabaseDirectoryEffect } from "@/effect/managed-databases"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
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
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { readInfraServerDirectory } from "@/server/infra-directory.server"
import { requiredRelay } from "@/server/managed-database-access"
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
  canDeploy: boolean
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

/** A game server's install, reinstall, or change of Brick, as listed. */
export interface ServerDeploymentView extends ServerDeploymentRecord {
  kind: "server"
  /** Who may read its log on the Relay. */
  canReadLogs: boolean
  relayName: string
  serverName: string
  /** The person who asked, by name. */
  triggeredByName: string | null
}

/** A database's redeploy, as listed. */
export interface DatabaseDeploymentView extends DatabaseDeploymentRecord {
  kind: "database"
  /** Who may read its log on the Relay. */
  canReadLogs: boolean
  databaseName: string
  relayName: string
  /** The person who asked, by name. */
  triggeredByName: string | null
}

/** A tunnel's redeploy, as listed. */
export interface TunnelDeploymentView extends TunnelDeploymentRecord {
  kind: "tunnel"
  /** Who may read its log on the Relay. */
  canReadLogs: boolean
  relayName: string
  /** The person who asked, by name. */
  triggeredByName: string | null
}

/** A deployment of any kind, as the Deployments page lists them. */
export type DeploymentView =
  | ({ kind: "app" } & AppDeploymentView)
  | DatabaseDeploymentView
  | ServerDeploymentView
  | TunnelDeploymentView

/** One App's deployments, one Relay's Apps', or every App the person reads. */
export async function getAppDeploymentsHandler(data: {
  appId?: string
  before?: { id: string; startedAt: string }
  relayId?: string
}) {
  const user = await requireEligibleResourceUser()
  const page = await listDeployments(
    user,
    {
      before: data.before,
      instance: data.appId ? { id: data.appId, kind: "app" } : undefined,
      relayId: data.relayId,
    },
    ["app"]
  )
  return {
    items: page.items.flatMap((item): Array<AppDeploymentView> =>
      item.kind === "app" ? [item] : []
    ),
    nextCursor: page.nextCursor,
  }
}

/**
 * Deployments of every App, game server and database the person can read,
 * or one Relay's, or one instance's history.
 */
export async function getDeploymentsHandler(data: {
  before?: { id: string; startedAt: string }
  instance?: { id: string; kind: DeploymentKind }
  relayId?: string
}) {
  const user = await requireEligibleResourceUser()
  // A tunnel's are listed on its own page (`getTunnelDeploymentsHandler`).
  const page = await listDeployments(user, data, ["app", "server", "database"])
  return {
    items: page.items.flatMap((item) => (item.kind === "tunnel" ? [] : [item])),
    nextCursor: page.nextCursor,
  }
}

/** One tunnel's deployments, for whoever may read its logs. */
export async function getTunnelDeploymentsHandler(data: {
  before?: { id: string; startedAt: string }
  tunnelId: string
}) {
  const user = await requireEligibleResourceUser()
  const tunnel = await requireTunnelPermission(
    user,
    data.tunnelId,
    "instance.logs.read"
  )
  const page = await listDeployments(
    user,
    {
      before: data.before,
      instance: { id: tunnel.id, kind: "tunnel" },
      relayId: tunnel.relayId,
    },
    ["tunnel"]
  )
  return {
    items: page.items.flatMap((item) => (item.kind === "tunnel" ? [item] : [])),
    nextCursor: page.nextCursor,
  }
}

async function listDeployments(
  user: AuthenticatedUser,
  data: {
    before?: { id: string; startedAt: string }
    instance?: { id: string; kind: DeploymentKind }
    relayId?: string
  },
  kinds: ReadonlyArray<DeploymentKind>
) {
  const [relays, grants, apps, servers, databases, tunnels] = await Promise.all([
    listPersistedRelays(),
    isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
    kinds.includes("app")
      ? runAppEffect("apps.directory", listAppRecordsEffect())
      : Promise.resolve([]),
    kinds.includes("server")
      ? runAppEffect("Infra.directory.servers", readInfraServerDirectory(user))
      : Promise.resolve([]),
    kinds.includes("database")
      ? runAppEffect(
          "managedDatabases.directory",
          listManagedDatabaseDirectoryEffect()
        )
      : Promise.resolve([]),
    kinds.includes("tunnel")
      ? runAppEffect("tunnels.list", listTunnelRecordsEffect())
      : Promise.resolve([]),
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
  const appRelayIds = [...relayNames.keys()].filter((relayId) =>
    hasAppPermission(user, grants, { relayId }, "app.read")
  )
  // Each game server the person reads, which its directory lists.
  const readableServers = new Map(
    servers.flatMap((server) =>
      relayNames.has(server.relayId) ? [[server.id, server] as const] : []
    )
  )
  const databasePermissions = (database: {
    databaseId: string
    relayId: string
  }) =>
    effectiveScopePermissions(grants, {
      relayId: database.relayId,
      resourceId: database.databaseId,
      resourceType: "database",
    })
  // Each database the person reads.
  const readableDatabases = new Map(
    databases.flatMap((database) =>
      relayNames.has(database.relayId) &&
      (isPlatformAdmin(user) ||
        databasePermissions(database).has("database.read"))
        ? [[database.databaseId, database] as const]
        : []
    )
  )
  // A tunnel's logs are its owner's, and anyone's who reads logs on its
  // Relay.
  const canReadTunnelLogs = (tunnel: { ownerId: string | null; relayId: string }) =>
    isPlatformAdmin(user) ||
    tunnel.ownerId === user.id ||
    effectiveScopePermissions(grants, {
      relayId: tunnel.relayId,
      resourceId: tunnel.relayId,
      resourceType: "relay",
    }).has("instance.logs.read")
  const readableTunnels = new Map(
    tunnels.flatMap((tunnel) =>
      relayNames.has(tunnel.relayId) && canReadTunnelLogs(tunnel)
        ? [[tunnel.id, tunnel] as const]
        : []
    )
  )
  const records = await runAppEffect(
    "deployments.list",
    listDeploymentsEffect({
      before: data.before,
      instance: data.instance,
      limit: deploymentPageSize + 1,
      reachable: {
        ...(kinds.includes("app") && {
          app: {
            instances: apps.flatMap((app) =>
              relayNames.has(app.relayId) &&
              !appRelayIds.includes(app.relayId) &&
              hasAppPermission(user, grants, app, "app.read")
                ? [{ id: app.appId, relayId: app.relayId }]
                : []
            ),
            relayIds: appRelayIds,
          },
        }),
        ...(kinds.includes("server") && {
          server: {
            instances: [...readableServers.values()].map((server) => ({
              id: server.id,
              relayId: server.relayId,
            })),
            relayIds: [],
          },
        }),
        ...(kinds.includes("database") && {
          database: {
            instances: [...readableDatabases.values()].map((database) => ({
              id: database.databaseId,
              relayId: database.relayId,
            })),
            relayIds: [],
          },
        }),
        ...(kinds.includes("tunnel") && {
          tunnel: {
            instances: [...readableTunnels.values()].map((tunnel) => ({
              id: tunnel.id,
              relayId: tunnel.relayId,
            })),
            relayIds: [],
          },
        }),
      },
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
  const triggeredByName = (record: DeploymentRecord, index: number) =>
    record.triggeredBy
      ? record.triggeredBy === user.id
        ? (user.name ?? user.email)
        : (people[index]?.ownerName ?? "Deleted user")
      : null
  const last = page.at(-1)
  return {
    items: page.map((record, index): DeploymentView => {
      const relayName = relayNames.get(record.relayId) ?? "Relay"
      if (record.kind === "server") {
        return {
          ...record,
          canReadLogs:
            isPlatformAdmin(user) ||
            effectiveScopePermissions(grants, {
              relayId: record.relayId,
              resourceId: record.instanceId,
              resourceType: "instance",
            }).has("instance.logs.read"),
          relayName,
          serverName:
            readableServers.get(record.instanceId)?.name ?? record.instanceId,
          triggeredByName: triggeredByName(record, index),
        }
      }
      if (record.kind === "tunnel") {
        return {
          ...record,
          canReadLogs: readableTunnels.has(record.tunnelId),
          relayName,
          triggeredByName: triggeredByName(record, index),
        }
      }
      if (record.kind === "database") {
        return {
          ...record,
          canReadLogs:
            isPlatformAdmin(user) ||
            databasePermissions(record).has("instance.logs.read"),
          databaseName:
            readableDatabases.get(record.databaseId)?.name ?? record.databaseId,
          relayName,
          triggeredByName: triggeredByName(record, index),
        }
      }
      return {
        ...record,
        appName: appNames.get(record.appId) ?? record.appId,
        canDeploy: hasAppPermission(user, grants, record, "instance.deploy"),
        canReadLogs: hasAppPermission(
          user,
          grants,
          record,
          "instance.logs.read"
        ),
        commitUrl: commitUrl(record),
        relayName,
        triggeredByName: triggeredByName(record, index),
      }
    }),
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
  const { relay } = await authorizedAppFor(user, data, "instance.deploy")
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
    app.config.sourceType === "image" || app.brick
      ? runAppEffect(
          "apps.imageUpdates.load",
          loadInstanceUpdateEffect(data.appId)
        )
      : null,
  ])
  // The image it checks, or none for one that follows a Brick and deploys
  // a Compose file or Dockerfile, which is checked for its Brick alone.
  const checkedImage =
    app.config.sourceType === "image" && app.config.image !== ""
      ? app.config.image
      : null
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
    // Nothing to check until it names an image, or follows a Brick with
    // something else to deploy.
    imageUpdates:
      checkedImage !== null || (app.brick && app.config.sourceType !== "image")
        ? updatesView(
            checkedImage,
            imageUpdate,
            currentImageUpdate(
              imageUpdate,
              checkedImage,
              latest.latest?.startedAt ?? null
            ),
            // The Brick it follows, as a check since its last deployment
            // found it running. One detached from its Brick has none,
            // whatever its container still says.
            app.brick
              ? currentBrickUpdate(
                  imageUpdate,
                  latest.latest?.startedAt ?? null
                )
              : null,
            checkedImage === null
          )
        : null,
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
  const { app, relay } = await authorizedAppFor(user, data, "app.manage")
  // Before the repository is saved: what an App deploys is its Brick's to
  // say while it follows one.
  if (app.brick) {
    throw new Error(
      `What it deploys is set by its Brick, ${app.brick.name}. Detach it from the Brick to change it.`
    )
  }
  // Changing its source is configuring it; deploying it at once is a deploy.
  if (data.deploy) await authorizedAppFor(user, data, "instance.deploy")
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
  const { app, relay } = await authorizedAppFor(user, record, "instance.deploy")
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

// What each kind's deployments are logged under on its Relay, how a grant
// names it, and what one is called.
const deploymentLogKinds = {
  app: {
    noun: "app",
    relayKind: "app",
    scope: "appId",
  },
  database: {
    noun: "database",
    relayKind: "database",
    scope: "databaseId",
  },
  server: {
    noun: "game server",
    relayKind: "instance",
    scope: "instanceId",
  },
  // Authorized as a tunnel is, by its owner or its Relay.
  tunnel: {
    noun: "tunnel",
    relayKind: "tunnel",
    scope: null,
  },
} as const satisfies Record<
  DeploymentKind,
  {
    noun: string
    relayKind: RelayDeploymentRead["kind"]
    scope: "appId" | "databaseId" | "instanceId" | null
  }
>

/**
 * Any kind of instance's deployment log, from its Relay while it keeps it,
 * for whoever can read that instance's logs (`instance.logs.read`).
 */
export async function getDeploymentLogHandler(
  user: AuthenticatedUser,
  data: {
    deploymentId: string
    instance: { id: string; kind: DeploymentKind }
  }
): Promise<{ log: RelayDeploymentLog; reason: string | null }> {
  const record = await runAppEffect(
    "deployments.load",
    loadDeploymentEffect(data.deploymentId)
  )
  if (!record) throw new Error("Deployment not found")
  const kind = deploymentLogKinds[record.kind]
  const instanceId = deploymentInstanceId(record)
  if (kind.scope === null) {
    await requireTunnelPermission(user, instanceId, "instance.logs.read")
  } else {
    await requireRelayPermission({
      [kind.scope]: instanceId,
      permission: "instance.logs.read",
      relayId: record.relayId,
      user,
    })
  }
  // Its page names the instance, so another's log can't pass as this one's.
  // Only after authorizing, so this says nothing of an instance the person
  // can't read.
  if (record.kind !== data.instance.kind || instanceId !== data.instance.id) {
    throw new Error("Deployment not found")
  }
  // An App's is named by its Relay, which may have refused it unnamed.
  const deploymentId =
    record.kind === "app" ? record.relayDeploymentId : record.id
  if (!deploymentId) {
    return { log: null, reason: "The Relay refused this deployment" }
  }
  const relay = await requiredRelay(record.relayId)
  if (relayConnectionFeatures(relay.id).size === 0) {
    return { log: null, reason: "The Relay is offline" }
  }
  const log = relayDeploymentLogSchema.parse(
    await databaseRpc(
      relay,
      "instance.deployment.read",
      { deploymentId, id: instanceId, kind: kind.relayKind },
      15_000,
      user.id
    )
  )
  return {
    log,
    reason: log
      ? null
      : `The Relay keeps only each ${kind.noun}'s 20 latest deployment logs`,
  }
}

function deploymentInstanceId(record: DeploymentRecord): string {
  switch (record.kind) {
    case "app":
      return record.appId
    case "database":
      return record.databaseId
    case "server":
      return record.instanceId
    case "tunnel":
      return record.tunnelId
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
