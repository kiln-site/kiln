/**
 * The one-time move to 12-character instance IDs, run as the Relay starts,
 * before anything reads Docker or admits work.
 *
 * Every game server, App, database, and Tailscale network the Relay has
 * from before had a 40-character hex ID, and the Relay itself was known by
 * its key's fingerprint. Each takes the new ID `migratedInstanceId` gives
 * it, which Hearth computes the same way on its own. Nothing physical is
 * renamed or moved: Docker can't rename volumes or networks or change a
 * container's labels, so every resource keeps the names its old ID gave
 * it, which `physicalKey` returns (instance-keys.ts), and what reads an ID
 * from a label, folder or name maps it back with `currentId`.
 *
 * The move:
 * 1. Finds every old ID: in Docker's labels, Compose project names and
 *    the Relay's folders, and in its SQLite records, each with what kind of
 *    instance it is, and saves the old ID of each new one.
 * 2. Rewrites the state files that name instances (Tailscale networks'
 *    configurations, restore journals, transfers, stopped Apps,
 *    deployments), leaving paths and Docker names, which are physical.
 * 3. Gives each container on a database's network the name its new ID
 *    gives it, beside the old one, since Docker can't add a name in place:
 *    Hearth gives Apps `DB_HOST=database-<new ID>`.
 * 4. Rewrites every record in SQLite at once and marks the move done.
 *
 * Each step can run again: a Relay stopped midway starts it over, and the
 * new IDs come out the same.
 */
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import {
  isLegacyRelayId,
  isLegacyResourceId,
  legacyIdRewriter,
  migratedInstanceId,
  relayFileRootId,
  type InstanceIdKind,
  type LegacyIdRewriter,
  type LegacyInstanceReference,
} from "@workspace/contracts"
import { Effect, Result } from "effect"

import type { RelayConfig } from "./config.js"
import { databaseMemberAliases } from "./database-connections.js"
import {
  isDockerNotFound,
  type DockerEngine,
  type DockerNetwork,
} from "./docker-engine.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { recoverPromise } from "./effect/promise.js"
import type { RelayIdentity } from "./effect/identity.js"
import type { RelayStateStore } from "./effect/state.js"
import {
  instanceIdFrom,
  useInstanceLegacyIds,
  type InstanceLegacyId,
} from "./instance-keys.js"
import { relayOwnsLabels, relayResourceNames } from "./relay-resources.js"

export const INSTANCE_IDS_MIGRATION_KEY = "instance_ids_v2"
// Set once every container on a database network has its new names, which
// may take more than one start.
const INSTANCE_ID_ALIASES_KEY = "instance_ids_aliases_v2"
// Attachments taken off a database network to join again with new names,
// written before each leaves, so one a stop cut off joins again next start.
const ALIAS_REPAIRS_KEY = "instance_ids_alias_repairs"

const DATABASE_CONNECTION_LABEL_PREFIX = "kiln.instance.databases."
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

// What an old ID found in two places is: a Tailscale network's container
// carries a game server's label, so the network's folder decides.
const KIND_PRIORITY: Record<InstanceIdKind, number> = {
  tailscale: 4,
  database: 3,
  app: 2,
  server: 1,
  relay: 0,
}

export interface InstanceIdMigrationInput {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  readonly identity: RelayIdentity
  readonly state: RelayStateStore["Service"]
}

/**
 * Moves the Relay to 12-character IDs if it hasn't yet, and loads the old
 * IDs migrated instances keep for their names.
 */
export async function migrateInstanceIds(
  input: InstanceIdMigrationInput
): Promise<void> {
  const { state } = input
  if (await Effect.runPromise(state.getMetadata(INSTANCE_IDS_MIGRATION_KEY))) {
    useInstanceLegacyIds(await Effect.runPromise(state.instanceIds.list()))
    await ensureDatabaseNetworkAliases(input)
    return
  }
  const started = Date.now()
  const entries = await legacyIds(input)
  await Effect.runPromise(state.instanceIds.save(entries))
  useInstanceLegacyIds(entries)
  const replacements = new Map(
    entries.map((entry) => [entry.legacyId, entry.id])
  )
  const rewriter = legacyIdRewriter(replacements)
  const rewrite = stateRewriter(rewriter, input.identity)
  const files = await rewriteStateFiles(input.config, rewrite)
  const rows = await Effect.runPromise(
    state.instanceIds.migrate({
      entries,
      marker: INSTANCE_IDS_MIGRATION_KEY,
      rewrite: (table, column, value) =>
        // A queued prune's repository is a path or URL, as it's named.
        table === "relay_backup_tasks" && column === "maintenance_key"
          ? value
          : rewrite(value),
    })
  )
  const aliases = await ensureDatabaseNetworkAliases(input)
  const counts = new Map<InstanceIdKind, number>()
  for (const entry of entries)
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  console.info(
    `Moved to 12-character instance IDs in ${Date.now() - started} ms: ${
      [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ") ||
      "nothing to move"
    }; rewrote ${rows} records, ${files} state files, and ${aliases} database network names`
  )
}

// Every old ID the Relay has, with its new one.
async function legacyIds(
  input: InstanceIdMigrationInput
): Promise<Array<InstanceLegacyId>> {
  const { identity, state } = input
  const references = [
    ...(await dockerReferences(input)),
    ...(await folderReferences(input.config, identity.fingerprint)),
    ...(await Effect.runPromise(
      state.instanceIds.legacyReferences(identity.fingerprint)
    )),
  ]
  // The Relay's own, unless it was made with a new ID.
  const ownId = await migratedInstanceId({
    fingerprint: identity.fingerprint,
    kind: "relay",
  })
  if (ownId === identity.id)
    references.push({ fingerprint: identity.fingerprint, kind: "relay" })

  // One reference per old ID: of the kind its strongest evidence says,
  // and a game server by this Relay's fingerprint when it's this Relay's.
  const chosen = new Map<string, LegacyInstanceReference>()
  for (const reference of references) {
    const legacyId =
      reference.kind === "relay" ? reference.fingerprint : reference.id
    const current = chosen.get(legacyId)
    if (
      !current ||
      KIND_PRIORITY[reference.kind] > KIND_PRIORITY[current.kind] ||
      (reference.kind === "server" &&
        current.kind === "server" &&
        reference.relayFingerprint === identity.fingerprint)
    )
      chosen.set(legacyId, reference)
  }
  // Saved before, by a move that stopped midway, the same again.
  const saved = await Effect.runPromise(state.instanceIds.list())
  const entries = new Map<string, InstanceLegacyId>(
    saved.map((entry) => [entry.legacyId, entry])
  )
  for (const [legacyId, reference] of chosen) {
    if (entries.has(legacyId)) continue
    entries.set(legacyId, {
      id: await migratedInstanceId(reference),
      kind: reference.kind,
      legacyId,
    })
  }
  const byId = new Map<string, string>()
  for (const entry of entries.values()) {
    const other = byId.get(entry.id)
    if (other !== undefined) {
      throw new Error(
        `Instance IDs ${other} and ${entry.legacyId} would both become ${entry.id}; the Relay can't move to 12-character IDs`
      )
    }
    byId.set(entry.id, entry.legacyId)
  }
  return [...entries.values()]
}

// The old IDs Docker's labels and names carry.
async function dockerReferences({
  config,
  engine,
  identity,
}: InstanceIdMigrationInput): Promise<Array<LegacyInstanceReference>> {
  const [containers, networks, volumes, images] = await Effect.runPromise(
    Effect.all(
      [
        engine.listContainers({ all: true }),
        engine.listNetworks(),
        engine.listVolumes(),
        engine.listImages(),
      ],
      { concurrency: "unbounded" }
    )
  )
  const references: Array<LegacyInstanceReference> = []
  const hex = (
    kind: "app" | "database" | "server" | "tailscale",
    value: string | undefined
  ) => {
    const id = value?.toLowerCase()
    if (!isLegacyResourceId(id)) return
    references.push(
      kind === "server"
        ? { id, kind, relayFingerprint: identity.fingerprint }
        : { id, kind }
    )
  }
  const projectBase = relayResourceNames(config).appComposeProject("")
  const fromLabels = (labels: Readonly<Record<string, string>> | null) => {
    if (!labels || !relayOwnsLabels(config, labels)) return
    hex("app", labels["kiln.app.id"])
    hex("database", labels["kiln.database.id"])
    hex("server", labels[config.serverIdLabel])
    const network = labels["kiln.relay.network"]
    if (network?.startsWith("tailscale:"))
      hex("tailscale", network.slice("tailscale:".length))
    const project = labels[COMPOSE_PROJECT_LABEL]
    if (project?.startsWith(projectBase))
      hex(
        "app",
        /^([a-f0-9]{40})(?:-\d{14})?$/u.exec(
          project.slice(projectBase.length)
        )?.[1]
      )
    for (const [label, value] of Object.entries(labels)) {
      if (!label.startsWith(DATABASE_CONNECTION_LABEL_PREFIX)) continue
      hex("database", label.slice(DATABASE_CONNECTION_LABEL_PREFIX.length))
      if (isLegacyRelayId(value))
        references.push({ fingerprint: value, kind: "relay" })
    }
  }
  for (const container of containers) fromLabels(container.Labels)
  for (const network of networks) fromLabels(network.Labels)
  for (const volume of volumes) fromLabels(volume.Labels)
  for (const image of images) fromLabels(image.Labels ?? null)
  return references
}

// The old IDs the Relay's folders are named after.
async function folderReferences(
  config: RelayConfig,
  ownFingerprint: string
): Promise<Array<LegacyInstanceReference>> {
  const references: Array<LegacyInstanceReference> = []
  // Game servers' folders and Tailscale networks' share a directory; a
  // network's holds its configuration.
  for (const name of await directoryNames(config.rootDirectory)) {
    if (!isLegacyResourceId(name)) continue
    const tailscale =
      existsSync(join(config.rootDirectory, name, "stack.json")) ||
      existsSync(join(config.rootDirectory, name, ".removing-stack.json"))
    references.push(
      tailscale
        ? { id: name, kind: "tailscale" }
        : { id: name, kind: "server", relayFingerprint: ownFingerprint }
    )
  }
  for (const [kind, folder] of [
    ["app", "apps"],
    ["app", "app-deployments"],
    ["app", "app-sources"],
    ["app", "app-mounts"],
    ["database", "database-dumps"],
  ] as const) {
    for (const name of await directoryNames(join(config.dataDirectory, folder)))
      if (isLegacyResourceId(name)) references.push({ id: name, kind })
  }
  for (const name of await directoryNames(
    join(config.dataDirectory, "infrastructure", "tailscale-stacks")
  ))
    if (isLegacyResourceId(name))
      references.push({ id: name, kind: "tailscale" })
  return references
}

async function directoryNames(directory: string): Promise<Array<string>> {
  return recoverPromise(
    async () =>
      (await readdir(directory, { withFileTypes: true })).flatMap((entry) =>
        entry.isDirectory() ? [entry.name] : []
      ),
    () => []
  )
}

/**
 * Rewrites the old IDs in a record or state file: in JSON, each value and
 * key but those that are physical (paths, Docker names and the like, which
 * keep the old ID they were made with) or cryptographic; in anything else,
 * the whole text unless it's physical. A file root that was the Relay's
 * fingerprint, its host files, becomes `relay:<id>`.
 */
function stateRewriter(
  rewriter: LegacyIdRewriter,
  identity: RelayIdentity
): (text: string) => string {
  if (rewriter.size === 0) return (text) => text
  const value = (item: unknown, key: string | null): unknown => {
    if (typeof item === "string") {
      if (key !== null && /root/iu.test(key) && item === identity.fingerprint)
        return relayFileRootId(identity.id)
      return text(item)
    }
    if (Array.isArray(item)) return item.map((entry) => value(entry, key))
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([name, entry]) => [
          text(name),
          PRESERVED_KEYS.has(name) ? entry : value(entry, name),
        ])
      )
    }
    return item
  }
  const text = (item: string): string =>
    isPhysical(item) ? item : rewriter.rewrite(item)
  return (item) => {
    const trimmed = item.trimStart()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const json = Result.try(() => JSON.parse(item) as unknown)
      if (Result.isFailure(json)) return text(item)
      const parsed = json.success
      const rewritten = withJoinRelayId(value(parsed, null), identity)
      const same = JSON.stringify(rewritten) === JSON.stringify(parsed)
      if (same) return item
      const indented = /^[{[]\n {2}/u.test(trimmed)
      return `${JSON.stringify(rewritten, null, indented ? 2 : undefined)}${
        item.endsWith("\n") ? "\n" : ""
      }`
    }
    return text(item)
  }
}

// Keys whose values keep the old ID they were made with: paths and Docker
// names, and what a signature or key covers.
const PRESERVED_KEYS = new Set([
  "dataDirectory",
  "directory",
  "dockerName",
  "grant",
  "hostDirectory",
  "instanceDirectory",
  "mountpoint",
  "path",
  "relayFingerprint",
  "relayPublicKeyPem",
  "signature",
  "source",
  "token",
])

// A path, or a Docker name such as `kiln-app-<id>-network`.
function isPhysical(text: string): boolean {
  return text.startsWith("/") || /(?:^|[^a-z0-9])kiln-/u.test(text)
}

// A join in progress announces the Relay by its ID too, which its saved
// envelope, from before, lacks.
function withJoinRelayId(value: unknown, identity: RelayIdentity): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("joinId" in value) ||
    !("envelope" in value)
  )
    return value
  const envelope = (value as { envelope: unknown }).envelope
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    "relayId" in envelope
  )
    return value
  return { ...value, envelope: { ...envelope, relayId: identity.id } }
}

// The state files that name instances, rewritten in place. Returns how
// many changed.
async function rewriteStateFiles(
  config: RelayConfig,
  rewrite: (text: string) => string
): Promise<number> {
  const files: Array<string> = []
  const jsonIn = async (directory: string) => {
    // A folder that isn't there yet holds nothing.
    for (const entry of await recoverPromise(
      () => readdir(directory, { withFileTypes: true }),
      () => []
    ))
      if (entry.isFile() && entry.name.endsWith(".json"))
        files.push(join(directory, entry.name))
  }
  // Tailscale networks' configurations, in their folders among game
  // servers', whose files are their own and never touched.
  for (const name of await directoryNames(config.rootDirectory)) {
    const directory = join(config.rootDirectory, name)
    if (
      !existsSync(join(directory, "stack.json")) &&
      !existsSync(join(directory, ".removing-stack.json"))
    )
      continue
    for (const file of [
      "stack.json",
      ".removing-stack.json",
      "dns-records.json",
    ])
      if (existsSync(join(directory, file))) files.push(join(directory, file))
  }
  const data = config.dataDirectory
  await jsonIn(join(data, "restores"))
  await jsonIn(join(data, "restores", "tar"))
  await jsonIn(join(data, "backup-state", "stopped"))
  await jsonIn(join(data, "transfers", "incoming"))
  await jsonIn(join(data, "transfers", "outgoing"))
  for (const app of await directoryNames(join(data, "app-deployments")))
    await jsonIn(join(data, "app-deployments", app))
  for (const file of ["networking.json", "proxy.json", "tailscale.json"])
    if (existsSync(join(data, file))) files.push(join(data, file))

  let changed = 0
  for (const file of files) {
    const before = await readFile(file, "utf8")
    const after = rewrite(before)
    if (after === before) continue
    const mode = (await stat(file)).mode & 0o777
    await Effect.runPromise(writeFileAtomic(file, after, mode))
    changed += 1
  }
  return changed
}

/**
 * Gives every container on a database's network the names its new ID gives
 * it, beside those it has: the database itself (`database-<id>`), and the
 * game servers, Apps, and databases connected to it. Docker can't add a
 * name to an attachment, so each joins again with all of them, a moment
 * off the network. One that fails is logged and keeps its old names.
 */
async function ensureDatabaseNetworkAliases(
  input: InstanceIdMigrationInput
): Promise<number> {
  const { state } = input
  if (await Effect.runPromise(state.getMetadata(INSTANCE_ID_ALIASES_KEY))) {
    return 0
  }
  const resumed = await resumeRepairs(input)
  const { added, complete } = await addDatabaseNetworkAliases(input)
  // Done only once each container has its names and none is left off its
  // network; anything Docker couldn't answer is tried again next start.
  if (resumed && complete && (await loadRepairs(state)).length === 0) {
    await Effect.runPromise(state.setMetadata(INSTANCE_ID_ALIASES_KEY, "1"))
  }
  return added
}

interface AliasRepair {
  readonly aliases: ReadonlyArray<string>
  readonly container: string
  readonly network: string
  readonly previous: ReadonlyArray<string>
}

async function loadRepairs(
  state: InstanceIdMigrationInput["state"]
): Promise<Array<AliasRepair>> {
  const saved = await Effect.runPromise(state.getMetadata(ALIAS_REPAIRS_KEY))
  if (!saved) return []
  try {
    const parsed = JSON.parse(saved) as unknown
    return Array.isArray(parsed) ? (parsed as Array<AliasRepair>) : []
  } catch {
    return []
  }
}

function saveRepairs(
  state: InstanceIdMigrationInput["state"],
  repairs: ReadonlyArray<AliasRepair>
): Promise<void> {
  return Effect.runPromise(
    state.setMetadata(ALIAS_REPAIRS_KEY, JSON.stringify(repairs))
  )
}

// Joins again what a stop, or a Docker that refused it, left off a database
// network between leaving it and joining it again with its new names. A
// repair stays recorded until the container is back on its network or gone.
async function resumeRepairs({
  engine,
  state,
}: InstanceIdMigrationInput): Promise<boolean> {
  const remaining: Array<AliasRepair> = []
  for (const repair of await loadRepairs(state)) {
    const inspected = await Effect.runPromise(
      Effect.result(engine.inspectContainer(repair.container))
    )
    if (Result.isFailure(inspected)) {
      if (!isDockerNotFound(inspected.failure)) remaining.push(repair)
      continue
    }
    if (inspected.success.NetworkSettings?.Networks?.[repair.network]) continue
    const outcome = await reattach(engine, repair, repair.container, false)
    if (outcome === "detached") remaining.push(repair)
  }
  await saveRepairs(state, remaining)
  return remaining.length === 0
}

/**
 * Takes a container off a database network, unless it's already off, and
 * joins it again with its new names, or as it was when Docker refuses them.
 */
async function reattach(
  engine: InstanceIdMigrationInput["engine"],
  repair: AliasRepair,
  name: string,
  attached = true
): Promise<"renamed" | "kept" | "detached"> {
  if (attached) {
    const left = await Effect.runPromise(
      engine.disconnectNetwork(repair.network, repair.container).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.warn(
              `${name} couldn't take its new name on ${repair.network}; it keeps ${repair.previous.join(", ") || "none"}:`,
              cause
            )
            return false
          })
        )
      )
    )
    if (!left) return "kept"
  }
  const joined = await Effect.runPromise(
    engine
      .connectNetwork(repair.network, repair.container, {
        aliases: [...repair.aliases],
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.warn(
              `${name} couldn't take its new name on ${repair.network}; joining again as before:`,
              cause
            )
            return false
          })
        )
      )
  )
  if (joined) {
    console.info(
      `${name} answers to ${repair.aliases.join(", ")} on ${repair.network}`
    )
    return "renamed"
  }
  // Back as it was, rather than off the network.
  return Effect.runPromise(
    engine
      .connectNetwork(repair.network, repair.container, {
        aliases: [...repair.previous],
      })
      .pipe(
        Effect.as("kept" as const),
        Effect.catch((again) =>
          Effect.sync(() => {
            console.error(
              `${name} couldn't join ${repair.network} again; it joins when it next starts:`,
              again
            )
            return "detached" as const
          })
        )
      )
  )
}

async function addDatabaseNetworkAliases({
  config,
  engine,
  state,
}: InstanceIdMigrationInput): Promise<{ added: number; complete: boolean }> {
  const resources = relayResourceNames(config)
  let added = 0
  let complete = true
  const networks = await Effect.runPromise(
    engine
      .listNetworks({ filters: { label: ["kiln.resource.kind=database"] } })
      .pipe(
        Effect.catch((cause) =>
          Effect.sync((): ReadonlyArray<DockerNetwork> | null => {
            console.warn(
              "Database networks couldn't be listed to name members:",
              cause
            )
            return null
          })
        )
      )
  )
  if (!networks) return { added, complete: false }
  for (const network of networks) {
    if (
      !relayOwnsLabels(config, network.Labels) ||
      network.Labels?.["kiln.database.network"] !== network.Name
    )
      continue
    const attached = await Effect.runPromise(
      engine
        .listContainers({ all: true, filters: { network: [network.Name] } })
        .pipe(Effect.orElseSucceed(() => null))
    )
    if (!attached) {
      complete = false
      continue
    }
    for (const summary of attached) {
      const labels = summary.Labels ?? {}
      const databaseId = instanceIdFrom(labels["kiln.database.id"])
      const serverId = instanceIdFrom(labels[config.serverIdLabel])
      const appId = instanceIdFrom(labels["kiln.app.id"])
      const wanted =
        labels["kiln.resource.kind"] === "database" && databaseId
          ? databaseMemberAliases({ id: databaseId, kind: "database" })
          : labels["kiln.resource.kind"] === "app" && appId
            ? resources.appAliases(appId, labels["kiln.app.service"] ?? "app")
            : serverId
              ? databaseMemberAliases({ id: serverId, kind: "instance" })
              : []
      if (wanted.length < 2) continue
      const container = await Effect.runPromise(
        engine
          .inspectContainer(summary.Id)
          .pipe(Effect.orElseSucceed(() => null))
      )
      if (!container) {
        complete = false
        continue
      }
      const endpoint = container.NetworkSettings?.Networks?.[network.Name]
      if (!endpoint) continue
      const current = endpoint.Aliases ?? []
      if (wanted.every((alias) => current.includes(alias))) continue
      // Docker adds a container's short ID itself.
      const aliases = [
        ...new Set([
          ...current.filter((alias) => !/^[a-f0-9]{12,64}$/u.test(alias)),
          ...wanted,
        ]),
      ]
      const name = summary.Names[0]?.replace(/^\//u, "") ?? summary.Id
      const repair: AliasRepair = {
        aliases,
        container: summary.Id,
        network: network.Name,
        previous: current,
      }
      await saveRepairs(state, [...(await loadRepairs(state)), repair])
      const outcome = await reattach(engine, repair, name)
      // One left off its network keeps its repair for the next start.
      if (outcome !== "detached") {
        await saveRepairs(
          state,
          (await loadRepairs(state)).filter(
            (pending) =>
              pending.container !== repair.container ||
              pending.network !== repair.network
          )
        )
      }
      if (outcome === "renamed") added += 1
      else complete = false
    }
  }
  return { added, complete }
}
