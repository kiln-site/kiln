import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"

import { builtinTailscaleBrickId } from "@workspace/contracts"
import { Effect, Result, Schema } from "effect"

import {
  convertGitHubManifestEffect,
  deleteGitHubInstallationEffect,
  forgetGitHubInstallationToken,
  getGitHubBranchHeadEffect,
  getGitHubInstallationEffect,
  getGitHubRepositoryEffect,
  getGitHubTreeEffect,
  githubAppManifest,
  githubInstallationTokenEffect,
  listGitHubBranchesEffect,
  listGitHubRepositoriesEffect,
  countGitHubRepositoriesEffect,
  type GitHubInstallation,
} from "@/effect/github-api"
import {
  deleteGitHubConnectionEffect,
  deleteGitHubSyncEffect,
  insertGitHubSyncEffect,
  insertGitHubConnectionEffect,
  loadGitHubConnectionCredentialEffect,
  loadGitHubConnectionsEffect,
  loadGitHubSyncEffect,
  loadGitHubSyncRunsEffect,
  loadGitHubSyncsEffect,
  saveGitHubInstallationEffect,
  updateGitHubSyncEffect,
  type GitHubConnection,
  type GitHubInstallationRecord,
  type GitHubSync,
  type GitHubSyncResourceKind,
  type GitHubSyncRun,
} from "@/effect/github-sync"
import { countAppGitHubSourcesEffect } from "@/effect/app-deployments"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { reportAppError, runAppEffect } from "@/effect/runtime"
import {
  grantsAllowPermission,
  isPlatformAdmin,
  listUserGrants,
  type AccessGrant,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { resolveDisplayName } from "@/lib/display-name"
import { betterAuthSecrets, kilnPublicUrl } from "@/lib/environment"
import { deployPushedAppsEffect } from "@/lib/app-deployments.server"
import {
  enqueueGitHubSync,
  publishGitHubSyncChange,
} from "@/lib/github-sync.server"
import {
  githubSyncTargetAccess,
  type GitHubSyncTargetKind,
} from "@/lib/github-sync-targets"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { listPersistedRelays } from "@/lib/relay-registry"
import { readLimitedText } from "@/lib/request-body"
import { requireEligibleResourceUser } from "@/server/auth"
import type {
  GitHubBranchesInput,
  GitHubFoldersInput,
  SaveGitHubSyncInput,
  StartGitHubConnectionInput,
} from "@/server/github-sync"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const SETUP_STATE_PURPOSE = "kiln-github-app-setup-state"
const setupStateLifetimeMs = 60 * 60_000

// Carried through GitHub's redirects so the callback knows who started the
// flow and, after the app exists, which connection to install.
const SetupStateSchema = Schema.Struct({
  connectionId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
  userId: Schema.String,
  webhooks: Schema.Boolean,
})
const decodeSetupState = Schema.decodeUnknownOption(
  Schema.fromJsonString(SetupStateSchema)
)

export type GitHubTargetKind = GitHubSyncTargetKind

export interface GitHubConnectionView {
  appName: string
  appOwnerLogin: string
  appSlug: string
  appUrl: string
  /** Apps that deploy from it. */
  deploymentCount: number
  id: string
  installUrl: string
  installation: GitHubInstallationRecord | null
  /** Where the installation's repository access is changed on GitHub. */
  manageUrl: string | null
  /** The Kiln user who added it; null if their account is gone. */
  ownerEmail: string | null
  /** For their picture; null if their account is gone. */
  ownerId: string | null
  ownerName: string | null
  /** Where the source lives; GitHub is the only one so far. */
  provider: "github"
  syncCount: number
  webhookActive: boolean
}

export interface GitHubSyncTarget {
  id: string
  kind: GitHubTargetKind
  name: string
  relayId: string
  relayName: string
}

export interface GitHubSyncView extends Omit<
  GitHubSync,
  "resourceId" | "resourceKind"
> {
  canManage: boolean
  connectionName: string
  target: GitHubSyncTarget
}

export async function getGitHubSyncOverviewHandler() {
  const user = await requireEligibleResourceUser()
  const admin = isPlatformAdmin(user)
  const [connections, syncs, relays, directory, apps, grants, deployments] =
    await Promise.all([
      runAppEffect("github.connections.load", loadGitHubConnectionsEffect()),
      runAppEffect("github.syncs.load", loadGitHubSyncsEffect()),
      listPersistedRelays(),
      runAppEffect("instances.directory.list", listInstanceDirectoryEffect()),
      runAppEffect("apps.list", listAppRecordsEffect()),
      admin ? Promise.resolve([]) : listUserGrants(user.id),
      runAppEffect("apps.github.sources.count", countAppGitHubSourcesEffect()),
    ])
  const relayNames = new Map(
    relays
      .filter((relay) => relay.enabled)
      .map((relay) => [relay.id, relay.name])
  )
  const allows = (target: GitHubSyncTarget, write: boolean) =>
    admin || targetAllows(grants, target, write)

  const allTargets: Array<GitHubSyncTarget> = [
    ...directory
      .filter((record) => record.brickId !== builtinTailscaleBrickId)
      .map((record) => ({
        id: record.id,
        kind: "server" as const,
        name: record.name,
        relayId: record.relayId,
        relayName: relayNames.get(record.relayId) ?? "",
      })),
    ...apps.map((app) => ({
      id: app.appId,
      kind: "app" as const,
      name: app.name,
      relayId: app.relayId,
      relayName: relayNames.get(app.relayId) ?? "",
    })),
    // A Relay's host files, under its own ID.
    ...[...relayNames].map(([id, name]) => ({
      id,
      kind: "relay" as const,
      name,
      relayId: id,
      relayName: name,
    })),
  ].filter((target) => relayNames.has(target.relayId))
  const targetsByKey = new Map(
    allTargets.map((target) => [targetKey(target), target])
  )
  const connectionNames = new Map(
    connections.map((connection) => [connection.id, connectionName(connection)])
  )
  const syncViews = syncs.flatMap((sync): Array<GitHubSyncView> => {
    const kind = targetKind(sync.resourceKind)
    const target = targetsByKey.get(
      targetKey({ id: sync.resourceId, kind, relayId: sync.relayId })
    ) ?? {
      id: sync.resourceId,
      kind,
      name: sync.resourceId.slice(0, 8),
      relayId: sync.relayId,
      relayName: relayNames.get(sync.relayId) ?? "Unknown Relay",
    }
    if (!allows(target, false)) return []
    const {
      resourceId: _resourceId,
      resourceKind: _resourceKind,
      ...rest
    } = sync
    return [
      {
        ...rest,
        canManage: allows(target, true),
        connectionName: connectionNames.get(sync.connectionId) ?? "GitHub",
        target,
      },
    ]
  })
  return {
    sources: await sourceViews(user, connections, syncs, deployments),
    syncs: syncViews,
    targets: allTargets.filter((target) => allows(target, true)),
  }
}

export interface GitHubSyncRunView extends GitHubSyncRun {
  sync: Pick<
    GitHubSyncView,
    "branch" | "repository" | "sourcePath" | "target" | "targetPath"
  >
}

/** Runs of the syncs the viewer can see, for Automations → History. */
export async function getGitHubSyncRunsHandler(): Promise<
  Array<GitHubSyncRunView>
> {
  const [overview, runs] = await Promise.all([
    getGitHubSyncOverviewHandler(),
    runAppEffect("github.sync.runs", loadGitHubSyncRunsEffect()),
  ])
  const syncs = new Map(overview.syncs.map((sync) => [sync.id, sync]))
  return runs.flatMap((run) => {
    const sync = syncs.get(run.syncId)
    if (!sync) return []
    return [
      {
        ...run,
        sync: {
          branch: sync.branch,
          repository: sync.repository,
          sourcePath: sync.sourcePath,
          target: sync.target,
          targetPath: sync.targetPath,
        },
      },
    ]
  })
}

/** The sources the viewer can see and use, for Infrastructure → Sources. */
export async function getGitHubSourcesHandler() {
  const user = await requireEligibleResourceUser()
  const [connections, syncs, deployments] = await Promise.all([
    runAppEffect("github.connections.load", loadGitHubConnectionsEffect()),
    runAppEffect("github.syncs.load", loadGitHubSyncsEffect()),
    runAppEffect("apps.github.sources.count", countAppGitHubSourcesEffect()),
  ])
  return {
    sources: await sourceViews(user, connections, syncs, deployments),
  }
}

/**
 * How many repositories a source can read. Separate from the list so the
 * table never waits on GitHub.
 */
export async function getGitHubSourceRepositoryCountHandler(data: {
  id: string
}) {
  const user = await requireEligibleResourceUser()
  const token = await connectionToken(user, data.id)
  return runAppEffect(
    "github.repositories.count",
    countGitHubRepositoriesEffect(token)
  )
}

async function sourceViews(
  user: AuthenticatedUser,
  connections: ReadonlyArray<GitHubConnection>,
  syncs: ReadonlyArray<GitHubSync>,
  deployments: ReadonlyMap<string, number>
): Promise<Array<GitHubConnectionView>> {
  const visible = connections.filter(
    (connection) => isPlatformAdmin(user) || connection.ownerUserId === user.id
  )
  // Viewers see only their own sources unless they're administrators, who
  // may see every owner's details.
  const owners = await runAppEffect(
    "github.connection.owners",
    attachRelayOwnersEffect(
      visible.map((connection) => ({ createdBy: connection.ownerUserId })),
      true
    )
  )
  const syncCounts = new Map<string, number>()
  for (const sync of syncs) {
    syncCounts.set(
      sync.connectionId,
      (syncCounts.get(sync.connectionId) ?? 0) + 1
    )
  }
  return visible.map((connection, index) => ({
    appName: connection.appName,
    appOwnerLogin: connection.appOwnerLogin,
    appSlug: connection.appSlug,
    appUrl: connection.appUrl,
    deploymentCount: deployments.get(connection.id) ?? 0,
    id: connection.id,
    installUrl: installUrl(connection.appSlug),
    installation: connection.installation,
    manageUrl: connection.installation
      ? installationSettingsUrl(connection.installation)
      : null,
    // The viewer is named from their session, which also covers the
    // development login that has no user row.
    ownerEmail:
      connection.ownerUserId === user.id
        ? user.email
        : (owners[index]?.ownerEmail ?? null),
    ownerId:
      connection.ownerUserId === user.id || owners[index]?.ownerName
        ? connection.ownerUserId
        : null,
    ownerName:
      connection.ownerUserId === user.id
        ? resolveDisplayName(user.name, user.email)
        : (owners[index]?.ownerName ?? null),
    provider: "github",
    syncCount: syncCounts.get(connection.id) ?? 0,
    webhookActive: connection.webhookActive,
  }))
}

export async function startGitHubConnectionHandler(
  data: StartGitHubConnectionInput
) {
  const user = await requireEligibleResourceUser()
  if (data.account === "organization" && !data.organization) {
    throw new Error("Enter the organization's GitHub name")
  }
  const hearthUrl = kilnPublicUrl()
  const webhooks = githubCanReach(hearthUrl)
  const state = encryptSetupState({
    expiresAt: Date.now() + setupStateLifetimeMs,
    userId: user.id,
    webhooks,
  })
  const base =
    data.account === "organization"
      ? `https://github.com/organizations/${encodeURIComponent(data.organization!)}/settings/apps/new`
      : "https://github.com/settings/apps/new"
  return {
    action: `${base}?state=${encodeURIComponent(state)}`,
    manifest: JSON.stringify(
      githubAppManifest({ hearthUrl, name: data.name, webhooks })
    ),
    webhooks,
  }
}

/**
 * GitHub's redirect after it creates the app: exchange the code for the
 * app's credentials, then send the person on to install it.
 */
export async function completeGitHubManifest(input: {
  code: string
  state: string
  user: AuthenticatedUser
}): Promise<string> {
  const state = readSetupState(input.state, input.user)
  const app = await runAppEffect(
    "github.app.convert",
    convertGitHubManifestEffect(input.code)
  )
  const connectionId = randomUUID()
  await runAppEffect(
    "github.connection.insert",
    insertGitHubConnectionEffect({
      appId: app.id,
      appName: app.name,
      appOwnerLogin: app.owner.login,
      appSlug: app.slug,
      appUrl: app.html_url,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      id: connectionId,
      ownerUserId: input.user.id,
      privateKey: app.pem,
      webhookActive: state.webhooks,
      webhookSecret: app.webhook_secret,
    })
  )
  publishGitHubSyncChange()
  const nextState = encryptSetupState({
    connectionId,
    expiresAt: Date.now() + setupStateLifetimeMs,
    userId: input.user.id,
    webhooks: state.webhooks,
  })
  return `${installUrl(app.slug)}?state=${encodeURIComponent(nextState)}`
}

/**
 * GitHub's redirect after the app is installed or its repositories change.
 * The installation is looked up with the app's own credentials, so a forged
 * installation ID can't attach someone else's account.
 */
export async function completeGitHubInstallation(input: {
  installationId: number
  state: string | null
  user: AuthenticatedUser
}): Promise<string> {
  const candidates = input.state
    ? [readSetupState(input.state, input.user).connectionId].filter(
        (id): id is string => id !== undefined
      )
    : (
        await runAppEffect(
          "github.connections.load",
          loadGitHubConnectionsEffect()
        )
      )
        .filter((connection) => connection.ownerUserId === input.user.id)
        .map((connection) => connection.id)
  for (const connectionId of candidates) {
    const connection = await runAppEffect(
      "github.connection.credential",
      loadGitHubConnectionCredentialEffect({ id: connectionId })
    )
    if (connection.ownerUserId !== input.user.id) continue
    const installation = await runAppEffect(
      "github.app.installation",
      getGitHubInstallationEffect(connection, input.installationId).pipe(
        Effect.option
      )
    )
    if (installation._tag === "None") continue
    if (installation.value.app_id !== connection.appId) continue
    await saveInstallation(connection.id, installation.value)
    return `/infra/sources?connected=${connection.id}`
  }
  throw new Error(
    "This installation doesn't belong to a GitHub App you connected"
  )
}

export async function deleteGitHubConnectionHandler(data: { id: string }) {
  const user = await requireEligibleResourceUser()
  const connection = await usableConnection(user, data.id)
  if (connection.installation) {
    // Best effort: the app may already be uninstalled on GitHub, and the
    // source goes either way once its credentials are forgotten.
    const installationId = connection.installation.id
    await runAppEffect(
      "github.app.uninstall",
      deleteGitHubInstallationEffect(connection, installationId).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            reportAppError(cause, { operation: "github.app.uninstall" })
          )
        )
      )
    )
    forgetGitHubInstallationToken(installationId)
  }
  await runAppEffect(
    "github.connection.delete",
    deleteGitHubConnectionEffect(connection.id)
  )
  publishGitHubSyncChange()
  return { deleted: true }
}

export async function listGitHubRepositoriesHandler(data: {
  connectionId: string
}) {
  const user = await requireEligibleResourceUser()
  const token = await connectionToken(user, data.connectionId)
  const repositories = await runAppEffect(
    "github.repositories.list",
    listGitHubRepositoriesEffect(token)
  )
  return repositories.map((repository) => ({
    defaultBranch: repository.default_branch,
    fullName: repository.full_name,
    id: repository.id,
    private: repository.private,
  }))
}

export async function listGitHubBranchesHandler(data: GitHubBranchesInput) {
  const user = await requireEligibleResourceUser()
  const token = await connectionToken(user, data.connectionId)
  return runAppEffect(
    "github.branches.list",
    listGitHubBranchesEffect(token, data.repository)
  )
}

/** The branch's folders, for choosing which one to sync. */
export async function listGitHubFoldersHandler(data: GitHubFoldersInput) {
  const user = await requireEligibleResourceUser()
  const token = await connectionToken(user, data.connectionId)
  const tree = await runAppEffect(
    "github.tree.folders",
    getGitHubBranchHeadEffect(token, data.repository, data.branch).pipe(
      Effect.flatMap((head) =>
        getGitHubTreeEffect(token, data.repository, head.sha)
      )
    )
  )
  const fileCounts = new Map<string, number>([["", 0]])
  for (const entry of tree.tree) {
    if (entry.type === "tree") {
      if (!fileCounts.has(entry.path)) fileCounts.set(entry.path, 0)
      continue
    }
    if (entry.type !== "blob") continue
    // Count each file toward every folder above it.
    const segments = entry.path.split("/")
    for (let depth = 0; depth < segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join("/")
      fileCounts.set(folder, (fileCounts.get(folder) ?? 0) + 1)
    }
  }
  return {
    folders: [...fileCounts]
      .map(([path, files]) => ({ files, path }))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, 2_000),
    truncated: tree.truncated,
  }
}

export async function saveGitHubSyncHandler(data: SaveGitHubSyncInput) {
  const user = await requireEligibleResourceUser()
  const existing = data.id
    ? await runAppEffect("github.sync.load", loadGitHubSyncEffect(data.id))
    : null
  // A sync keeps its instance; changing it means a new sync.
  const target = existing
    ? {
        id: existing.resourceId,
        kind: targetKind(existing.resourceKind),
        relayId: existing.relayId,
      }
    : data.target
  if (existing) {
    await requireTargetWrite(user, target)
  } else {
    // A new sync must name an instance that exists on its Relay and that
    // the person may write to, as the Sync page lists them.
    const { targets } = await getGitHubSyncOverviewHandler()
    const key = targetKey(target)
    if (!targets.some((candidate) => targetKey(candidate) === key)) {
      throw new Error("Instance not found")
    }
  }
  const token = await connectionToken(user, data.connectionId)
  // The repository's ID survives renames, so pushes match it after one.
  const repository = await runAppEffect(
    "github.repository.get",
    getGitHubRepositoryEffect(token, data.repository)
  )
  const settings = {
    autoSync: data.autoSync,
    branch: data.branch,
    includePatterns: data.includePatterns,
    overwrite: data.overwrite,
    repository: repository.full_name,
    repositoryId: repository.id,
    sourcePath: data.sourcePath,
    targetPath: data.targetPath,
  }
  if (existing) {
    if (existing.connectionId !== data.connectionId) {
      throw new Error("A sync keeps the GitHub connection it was created with")
    }
    await runAppEffect(
      "github.sync.update",
      updateGitHubSyncEffect(existing.id, settings)
    )
    enqueueGitHubSync(existing.id, "manual")
    return { id: existing.id }
  }
  const id = randomUUID()
  await runAppEffect(
    "github.sync.insert",
    insertGitHubSyncEffect({
      ...settings,
      connectionId: data.connectionId,
      createdBy: user.id,
      id,
      relayId: target.relayId,
      resourceId: target.id,
      resourceKind: target.kind === "server" ? "instance" : target.kind,
    })
  )
  enqueueGitHubSync(id, "created")
  return { id }
}

export async function runGitHubSyncHandler(data: { id: string }) {
  const user = await requireEligibleResourceUser()
  const sync = await manageableSync(user, data.id)
  enqueueGitHubSync(sync.id, "manual")
  return { queued: true }
}

export async function deleteGitHubSyncHandler(data: { id: string }) {
  const user = await requireEligibleResourceUser()
  const sync = await manageableSync(user, data.id)
  await runAppEffect("github.sync.delete", deleteGitHubSyncEffect(sync.id))
  publishGitHubSyncChange()
  return { deleted: true }
}

/**
 * Whether GitHub can deliver webhooks to Hearth: a public HTTPS address.
 * Elsewhere, connections poll for new commits instead.
 */
export function githubCanReach(url: URL): boolean {
  if (url.protocol !== "https:") return false
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase()
  if (isIP(hostname)) return !privateAddress(hostname)
  return (
    hostname.includes(".") &&
    !/\.(?:local|localhost|internal|lan|home\.arpa|ts\.net)$/u.test(hostname)
  )
}

function privateAddress(address: string): boolean {
  return (
    /^(?:10|127)\./u.test(address) ||
    /^192\.168\./u.test(address) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(address) ||
    /^169\.254\./u.test(address) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(address) ||
    address === "::1" ||
    /^f[cd]/u.test(address) ||
    /^fe80:/u.test(address)
  )
}

async function saveInstallation(
  connectionId: string,
  installation: GitHubInstallation | null
) {
  await runAppEffect(
    "github.connection.saveInstallation",
    saveGitHubInstallationEffect(
      connectionId,
      installation && installationRecord(installation)
    )
  )
  publishGitHubSyncChange()
}

function installationRecord(
  installation: GitHubInstallation
): GitHubInstallationRecord {
  return {
    accountAvatarUrl: installation.account.avatar_url ?? null,
    accountLogin: installation.account.login,
    accountType:
      installation.account.type === "Organization" ? "Organization" : "User",
    id: installation.id,
    repositorySelection: installation.repository_selection,
    suspended: Boolean(installation.suspended_at),
  }
}

async function usableConnection(user: AuthenticatedUser, id: string) {
  const connection = await runAppEffect(
    "github.connection.credential",
    loadGitHubConnectionCredentialEffect({ id })
  )
  if (connection.ownerUserId !== user.id && !isPlatformAdmin(user)) {
    throw new Error("GitHub connection not found")
  }
  return connection
}

/** A token for a connection the person may use: theirs, or any for admins. */
export async function connectionToken(
  user: AuthenticatedUser,
  connectionId: string
) {
  const connection = await usableConnection(user, connectionId)
  if (!connection.installation) {
    throw new Error("Install the GitHub App on an account first")
  }
  if (connection.installation.suspended) {
    throw new Error("The GitHub App is suspended on this account")
  }
  return runAppEffect(
    "github.app.installationToken",
    githubInstallationTokenEffect(connection, connection.installation.id)
  )
}

async function manageableSync(user: AuthenticatedUser, id: string) {
  const sync = await runAppEffect("github.sync.load", loadGitHubSyncEffect(id))
  await requireTargetWrite(user, {
    id: sync.resourceId,
    kind: targetKind(sync.resourceKind),
    relayId: sync.relayId,
  })
  return sync
}

async function requireTargetWrite(
  user: AuthenticatedUser,
  target: { id: string; kind: GitHubTargetKind; relayId: string }
) {
  if (!githubSyncTargetAccess(target)) throw new Error("Instance not found")
  if (isPlatformAdmin(user)) return
  const grants = await listUserGrants(user.id, target.relayId)
  if (!targetAllows(grants, target, true)) {
    throw new Error(
      target.kind === "app"
        ? "You need permission to edit this app's files"
        : target.kind === "relay"
          ? "You need permission to edit this Relay's files"
          : "You need permission to edit this game server's files"
    )
  }
}

function targetAllows(
  grants: ReadonlyArray<AccessGrant>,
  target: { id: string; kind: GitHubTargetKind; relayId: string },
  write: boolean
) {
  const access = githubSyncTargetAccess(target)
  return (
    access !== null &&
    grantsAllowPermission(
      grants,
      write ? access.write : access.read,
      access.scope
    )
  )
}

function targetKind(kind: GitHubSyncResourceKind): GitHubTargetKind {
  return kind === "instance" ? "server" : kind
}

function targetKey(target: { id: string; kind: string; relayId: string }) {
  return `${target.kind}:${target.relayId}:${target.id}`
}

function connectionName(connection: GitHubConnection) {
  return connection.installation?.accountLogin ?? connection.appName
}

function installUrl(slug: string) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

function installationSettingsUrl(installation: GitHubInstallationRecord) {
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`
}

function encryptSetupState(state: typeof SetupStateSchema.Type) {
  return encryptWithKeyring(
    JSON.stringify(state),
    betterAuthSecrets(),
    SETUP_STATE_PURPOSE
  )
}

function readSetupState(value: string, user: AuthenticatedUser) {
  const decrypted = Result.try(
    () =>
      decryptWithKeyring(value, betterAuthSecrets(), SETUP_STATE_PURPOSE)
        .plaintext
  )
  if (Result.isFailure(decrypted)) {
    throw new Error("This GitHub setup link is invalid")
  }
  const state = decodeSetupState(decrypted.success)
  if (state._tag === "None" || state.value.expiresAt < Date.now()) {
    throw new Error("This GitHub setup link expired; start again from Kiln")
  }
  // The person finishing the flow must be the one who started it.
  if (state.value.userId !== user.id) {
    throw new Error("Sign in as the account that started connecting GitHub")
  }
  return state.value
}

const PushEventSchema = Schema.Struct({
  // A push that deletes the branch.
  deleted: Schema.optionalKey(Schema.Boolean),
  ref: Schema.String,
  repository: Schema.Struct({ id: Schema.Number }),
})
const InstallationEventSchema = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({
    account: Schema.Struct({
      avatar_url: Schema.optionalKey(Schema.String),
      login: Schema.String,
      type: Schema.String,
    }),
    app_id: Schema.Number,
    id: Schema.Number,
    repository_selection: Schema.Literals(["all", "selected"]),
    suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
})
const decodePushEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(PushEventSchema)
)
const decodeInstallationEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(InstallationEventSchema)
)

/**
 * A delivery to a connected app's webhook. Each app signs with its own
 * secret, so the app named in the headers picks the secret that verifies it.
 */
export async function handleGitHubWebhook(request: Request): Promise<Response> {
  const appId = Number(
    request.headers.get("x-github-hook-installation-target-id")
  )
  const signature = request.headers.get("x-hub-signature-256") ?? ""
  const event = request.headers.get("x-github-event") ?? ""
  if (!Number.isSafeInteger(appId) || !signature.startsWith("sha256=")) {
    return new Response("Missing GitHub signature", { status: 400 })
  }
  if (Number(request.headers.get("content-length") ?? 0) > maxDeliveryBytes) {
    return new Response("Delivery too large", { status: 413 })
  }
  // Read before the signature can be checked, so the limit holds even when
  // a sender leaves out its length.
  const body = await readLimitedText(request, maxDeliveryBytes)
  if (body === null) {
    return new Response("Delivery too large", { status: 413 })
  }
  const connection = await runAppEffect(
    "github.webhook.connection",
    loadGitHubConnectionCredentialEffect({ appId }).pipe(Effect.option)
  )
  if (
    connection._tag === "None" ||
    !connection.value.webhookSecret ||
    !validGitHubSignature(connection.value.webhookSecret, body, signature)
  ) {
    return new Response("Invalid signature", { status: 401 })
  }
  const app = connection.value
  if (event === "push") {
    const push = decodePushEvent(body)
    if (push._tag === "Some" && push.value.ref.startsWith("refs/heads/")) {
      const syncs = await runAppEffect(
        "github.syncs.load",
        loadGitHubSyncsEffect({
          connectionId: app.id,
          repositoryId: push.value.repository.id,
        })
      )
      const branch = push.value.ref.slice("refs/heads/".length)
      for (const sync of syncs) {
        if (sync.autoSync && sync.branch === branch)
          enqueueGitHubSync(sync.id, "push")
      }
      // A deleted branch has nothing to deploy.
      if (!push.value.deleted) {
        await runAppEffect(
          "github.webhook.deploy",
          deployPushedAppsEffect({
            branch,
            connectionId: app.id,
            repositoryId: push.value.repository.id,
          })
        )
      }
    }
  } else if (event === "installation") {
    const change = decodeInstallationEvent(body)
    if (
      change._tag === "Some" &&
      change.value.installation.app_id === app.appId
    ) {
      forgetGitHubInstallationToken(change.value.installation.id)
      await saveInstallation(
        app.id,
        change.value.action === "deleted" ? null : change.value.installation
      )
    }
  }
  return new Response(null, { status: 204 })
}

// GitHub caps deliveries at 25 MB.
const maxDeliveryBytes = 25 * 1024 * 1024

/** The body as text, or null once it passes `limit` bytes. */

function validGitHubSignature(secret: string, body: string, signature: string) {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  )
  const received = Buffer.from(signature)
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  )
}
