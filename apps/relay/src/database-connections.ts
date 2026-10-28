import {
  databaseIdSchema,
  relayIdSchema,
  type DatabaseConnectionMember,
  type DatabaseConnectionMemberKind,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import { DockerEngine } from "./docker-engine.js"
import {
  DATABASE_CONNECTION_RECOVERY_KEY,
  type RelayStateStore,
  type RelayStoredDatabaseConnection,
} from "./effect/state.js"
import { recoverPromise } from "./effect/promise.js"
import { relayOwnsLabels } from "./relay-resources.js"

export const DATABASE_CONNECTION_LABEL_PREFIX = "kiln.instance.databases."
const VERSION_LABEL = `${DATABASE_CONNECTION_LABEL_PREFIX}version`

type DatabaseReference = Pick<
  RelayStoredDatabaseConnection,
  "databaseId" | "relayId"
>

export interface DatabaseConnectionSnapshot {
  instanceId: string
  service: string
  labels: Readonly<Record<string, string | undefined>>
  networks: ReadonlyArray<string>
}

function databaseConnectionLabels(
  connections: ReadonlyArray<DatabaseReference>
): Record<string, string> {
  return {
    [VERSION_LABEL]: "1",
    ...Object.fromEntries(
      [...connections]
        .sort((a, b) => a.databaseId.localeCompare(b.databaseId))
        .map(({ databaseId, relayId }) => [
          `${DATABASE_CONNECTION_LABEL_PREFIX}${databaseId}`,
          relayId,
        ])
    ),
  }
}

function decodeDatabaseConnectionLabels(
  labels: Readonly<Record<string, string | undefined>>
) {
  const connections: Array<DatabaseReference> = []
  const warnings: Array<string> = []
  const version = labels[VERSION_LABEL]
  if (version === undefined) return { connections, warnings }
  if (version !== "1")
    return {
      connections,
      warnings: [`Unsupported database connection label version: ${version}`],
    }
  for (const [label, value] of Object.entries(labels)) {
    if (
      !label.startsWith(DATABASE_CONNECTION_LABEL_PREFIX) ||
      label === VERSION_LABEL
    )
      continue
    const databaseId = databaseIdSchema.safeParse(
      label.slice(DATABASE_CONNECTION_LABEL_PREFIX.length)
    )
    const relayId = relayIdSchema.safeParse(value)
    if (!databaseId.success || !relayId.success) {
      warnings.push(`Invalid database connection label: ${label}`)
      continue
    }
    connections.push({ databaseId: databaseId.data, relayId: relayId.data })
  }
  return { connections, warnings }
}

export interface DatabaseConnectionIssue {
  databaseId: string | null
  message: string
}

/**
 * A container of a member that joins its databases' networks, under the
 * alias it answers to there, if any.
 */
export interface DatabaseConnectionTarget {
  readonly alias?: string
  readonly container: string
}

/**
 * A member's containers, or null when the member doesn't exist on this
 * Relay. A member that exists but has no containers yet, as an App before
 * its first deploy, has none.
 */
export type DatabaseConnectionMemberResolver = (
  id: string
) => Promise<ReadonlyArray<DatabaseConnectionTarget> | null>

const memberKey = (member: DatabaseConnectionMember) =>
  `${member.kind}:${member.id}`

/**
 * The Relay's database connections, for every member kind: game servers,
 * Apps, and databases. The Relay is their one authority. A connection is
 * kept whether or not its network or member's containers exist now, and
 * applied whenever the member's containers change.
 */
export class DatabaseConnections {
  readonly #saved = new Map<string, ReadonlyArray<DatabaseReference>>()

  saved(member: DatabaseConnectionMember): ReadonlyArray<DatabaseReference> {
    return this.#saved.get(memberKey(member)) ?? []
  }

  readonly #issues = new Map<string, Array<DatabaseConnectionIssue>>()

  issues(
    member: DatabaseConnectionMember
  ): ReadonlyArray<DatabaseConnectionIssue> {
    return this.#issues.get(memberKey(member)) ?? []
  }

  readonly #members = new Map<
    DatabaseConnectionMemberKind,
    DatabaseConnectionMemberResolver
  >()

  /** How members of one kind are found, registered by the kind's driver. */
  useMembers(
    kind: DatabaseConnectionMemberKind,
    resolve: DatabaseConnectionMemberResolver
  ): void {
    this.#members.set(kind, resolve)
  }

  /** The member's containers, or null when it doesn't exist. */
  async resolve(
    member: DatabaseConnectionMember
  ): Promise<ReadonlyArray<DatabaseConnectionTarget> | null> {
    const resolve = this.#members.get(member.kind)
    if (!resolve) throw new Error(`No ${member.kind} members on this Relay`)
    return resolve(member.id)
  }

  // Names are retained in Docker's old container snapshot even after a network
  // disappears. Leave these exclusively to database reconciliation.
  isDatabaseNetwork(network: string): boolean {
    return this.#databaseIdFromNetwork(network) !== null
  }

  #databaseIdFromNetwork(network: string): string | null {
    const prefix = this.config.resourceNamespace
      ? `${this.config.resourceNamespace}-kiln-db-`
      : "kiln-db-"
    return network.startsWith(prefix) &&
      /^[a-f0-9]{40}-network$/u.test(network.slice(prefix.length))
      ? network.slice(prefix.length, prefix.length + 40)
      : null
  }

  readonly #docker: DockerEngine

  constructor(
    readonly config: RelayConfig,
    readonly state: RelayStateStore["Service"]
  ) {
    this.#docker = new DockerEngine(config.dockerSocket)
  }

  async initialize(
    snapshots: ReadonlyArray<DatabaseConnectionSnapshot>
  ): Promise<void> {
    await this.#recover(snapshots)
    const connections = await Effect.runPromise(
      this.state.listDatabaseConnections()
    )
    this.#saved.clear()
    for (const connection of connections) {
      const key = memberKey({
        id: connection.memberId,
        kind: connection.memberKind,
      })
      this.#saved.set(key, [
        ...(this.#saved.get(key) ?? []),
        { databaseId: connection.databaseId, relayId: connection.relayId },
      ])
    }
  }

  async #recover(
    snapshots: ReadonlyArray<DatabaseConnectionSnapshot>
  ): Promise<void> {
    if (
      await Effect.runPromise(
        this.state.getMetadata(DATABASE_CONNECTION_RECOVERY_KEY)
      )
    )
      return
    const issues: Array<DatabaseConnectionIssue> = []
    const networks = await recoverPromise(
      () => this.#networks(issues),
      (cause) => {
        issues.push({
          databaseId: null,
          message: `Database network discovery unavailable during recovery: ${String(cause)}`,
        })
        return new Map<string, string>()
      }
    )
    for (const issue of issues) console.warn(issue.message)
    const recovered: Array<RelayStoredDatabaseConnection> = []
    for (const snapshot of snapshots) {
      const decoded = decodeDatabaseConnectionLabels(snapshot.labels)
      for (const warning of decoded.warnings)
        console.warn(`${snapshot.service}: ${warning}`)
      // Container labels are immutable. Local memberships reflect newer live
      // connect/disconnect operations, so prefer them when recovering state.
      // Keep remote references for future cross-Relay support, without trying
      // to attach those IDs to a local network.
      const connections = decoded.connections.filter(
        ({ databaseId, relayId }) =>
          relayId !== this.config.nodeId || !networks.has(databaseId)
      )
      for (const [databaseId, network] of networks) {
        if (snapshot.networks.includes(network))
          connections.push({ databaseId, relayId: this.config.nodeId })
      }
      // Owned network names in the container snapshot carry the full database
      // ID. Recover these even if the network is gone or could not be listed.
      // This makes the import complete without erasing live, unlabeled intent.
      for (const network of snapshot.networks) {
        const databaseId = this.#databaseIdFromNetwork(network)
        if (
          databaseId &&
          !connections.some(
            (connection) =>
              connection.databaseId === databaseId &&
              connection.relayId === this.config.nodeId
          )
        )
          connections.push({ databaseId, relayId: this.config.nodeId })
      }
      recovered.push(
        ...connections.map((connection) => ({
          ...connection,
          memberId: snapshot.instanceId,
          memberKind: "instance" as const,
        }))
      )
    }
    await Effect.runPromise(this.state.recoverDatabaseConnections(recovered))
  }

  /** A game server's connections, as the labels its container carries. */
  async labels(instanceId: string): Promise<Record<string, string>> {
    return databaseConnectionLabels(
      await this.list({ id: instanceId, kind: "instance" })
    )
  }

  /** A member's saved connections, as SQLite has them now. */
  async list(
    member: DatabaseConnectionMember
  ): Promise<ReadonlyArray<DatabaseReference>> {
    return Effect.runPromise(this.state.listMemberDatabaseConnections(member))
  }

  async set(
    member: DatabaseConnectionMember,
    databaseId: string,
    connected: boolean,
    relayId = this.config.nodeId
  ): Promise<void> {
    // Persist intent first so a failed Docker operation can be retried safely.
    await Effect.runPromise(
      this.state.setDatabaseConnection(
        {
          databaseId,
          memberId: member.id,
          memberKind: member.kind,
          relayId,
        },
        connected
      )
    )
    const remaining = this.saved(member).filter(
      (connection) =>
        connection.databaseId !== databaseId ||
        (!connected && connection.relayId !== relayId)
    )
    this.#saved.set(
      memberKey(member),
      connected ? [...remaining, { databaseId, relayId }] : remaining
    )
  }

  /**
   * Adds Apps' connections to databases on this Relay, keeping any already
   * saved, and says how many were new. Apps and databases deleted since
   * Hearth saved them are left out, and so is any pair someone connected or
   * disconnected on this Relay, so no handover, repeated or from another
   * Hearth, brings back a connection a person or a deletion removed. Applies
   * nothing: the Apps' running
   * containers joined these when they were saved, and the rest join on
   * their next deploy.
   */
  async importApps(
    apps: ReadonlyArray<{ appId: string; databaseIds: ReadonlyArray<string> }>
  ): Promise<number> {
    const databases = new Map<string, Promise<boolean>>()
    const exists = (member: DatabaseConnectionMember) =>
      this.resolve(member).then((targets) => targets !== null)
    const connections: Array<RelayStoredDatabaseConnection> = []
    const imported: Array<string> = []
    for (const { appId, databaseIds } of apps) {
      if (!(await exists({ id: appId, kind: "app" }))) continue
      imported.push(appId)
      for (const databaseId of new Set(databaseIds)) {
        let found = databases.get(databaseId)
        if (!found) {
          found = exists({ id: databaseId, kind: "database" })
          databases.set(databaseId, found)
        }
        if (!(await found)) continue
        connections.push({
          databaseId,
          memberId: appId,
          memberKind: "app",
          relayId: this.config.nodeId,
        })
      }
    }
    const added = await Effect.runPromise(
      this.state.importDatabaseConnections(connections)
    )
    for (const appId of imported) {
      const member = { id: appId, kind: "app" as const }
      this.#saved.set(memberKey(member), await this.list(member))
    }
    return added
  }

  async forgetMember(member: DatabaseConnectionMember): Promise<void> {
    await Effect.runPromise(this.state.deleteMemberDatabaseConnections(member))
    this.#issues.delete(memberKey(member))
    this.#saved.delete(memberKey(member))
  }

  async forgetDatabase(databaseId: string): Promise<void> {
    await Effect.runPromise(
      this.state.deleteDatabaseConnections(this.config.nodeId, databaseId)
    )
    // As a member, too.
    const own = { id: databaseId, kind: "database" as const }
    this.#issues.delete(memberKey(own))
    this.#saved.delete(memberKey(own))
    for (const [key, connections] of this.#saved)
      this.#saved.set(
        key,
        connections.filter(
          (connection) =>
            connection.databaseId !== databaseId ||
            connection.relayId !== this.config.nodeId
        )
      )
    for (const [key, issues] of this.#issues)
      this.#issues.set(
        key,
        issues.filter((issue) => issue.databaseId !== databaseId)
      )
  }

  /** Applies a member's saved connections to its containers as they are. */
  async reconcileMember(
    member: DatabaseConnectionMember
  ): Promise<Array<DatabaseConnectionIssue>> {
    const targets = await this.resolve(member)
    return targets ? this.reconcile(member, targets) : []
  }

  /**
   * Joins each of the member's containers to the networks of the databases
   * it's connected to on this Relay, and takes it off any other database's.
   * A database member never leaves its own network.
   */
  async reconcile(
    member: DatabaseConnectionMember,
    targets: ReadonlyArray<DatabaseConnectionTarget>
  ): Promise<Array<DatabaseConnectionIssue>> {
    const issues: Array<DatabaseConnectionIssue> = []
    // Database attachments are optional to the container lifecycle. Report
    // discovery/inspection failures too, without discarding the saved intent.
    await recoverPromise(
      async () => {
        const connections = await this.list(member)
        const networks = await this.#networks(issues)
        const desired = new Set<string>()
        for (const connection of connections) {
          if (connection.relayId !== this.config.nodeId) continue
          const network = networks.get(connection.databaseId)
          if (!network) {
            issues.push({
              databaseId: connection.databaseId,
              message: "Database network is unavailable on this Relay",
            })
            continue
          }
          desired.add(network)
        }
        if (networks.size === 0) return
        for (const target of targets) {
          const container = await Effect.runPromise(
            this.#docker.inspectContainer(target.container)
          )
          const attached = container.NetworkSettings?.Networks ?? {}
          for (const [databaseId, network] of networks) {
            if (member.kind === "database" && databaseId === member.id) continue
            const connect = desired.has(network)
            if (connect === Object.hasOwn(attached, network)) continue
            await recoverPromise(
              () =>
                Effect.runPromise(
                  connect
                    ? this.#docker.connectNetwork(network, target.container, {
                        aliases: target.alias ? [target.alias] : [],
                      })
                    : this.#docker.disconnectNetwork(network, target.container)
                ),
              (cause) => {
                issues.push({
                  databaseId,
                  message: `Could not ${connect ? "connect" : "disconnect"} database: ${cause instanceof Error ? cause.message : String(cause)}`,
                })
              }
            )
          }
        }
      },
      (cause) => {
        issues.push({
          databaseId: null,
          message: `Could not restore database connections: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    )
    this.#issues.set(memberKey(member), issues)
    for (const issue of issues)
      console.warn(
        `${member.kind} ${member.id.slice(0, 8)}: ${issue.databaseId ?? "databases"}: ${issue.message}`
      )
    return issues
  }

  async #networks(
    issues: Array<DatabaseConnectionIssue>
  ): Promise<Map<string, string>> {
    // Listed networks carry their labels, so no network is inspected.
    const networks = await Effect.runPromise(
      this.#docker.listNetworks({
        filters: { label: ["kiln.resource.kind=database"] },
      })
    )
    const ambiguous = new Set<string>()
    const result = new Map<string, string>()
    for (const network of networks) {
      if (!relayOwnsLabels(this.config, network.Labels)) continue
      const id = databaseIdSchema.safeParse(
        network.Labels?.["kiln.database.id"]
      )
      if (
        !id.success ||
        network.Labels?.["kiln.database.network"] !== network.Name
      )
        continue
      if (ambiguous.has(id.data)) continue
      if (result.has(id.data)) {
        issues.push({
          databaseId: id.data,
          message: "Multiple database networks found; connection skipped",
        })
        ambiguous.add(id.data)
        result.delete(id.data)
        continue
      }
      result.set(id.data, network.Name)
    }
    return result
  }
}
