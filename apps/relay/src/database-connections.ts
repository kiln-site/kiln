import { databaseIdSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"

import { command } from "./command.js"
import type { RelayConfig } from "./config.js"
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

export function databaseConnectionLabels(
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

export function decodeDatabaseConnectionLabels(
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

interface DatabaseNetwork {
  Name: string
  Labels: Record<string, string> | null
}

export interface DatabaseConnectionIssue {
  databaseId: string | null
  message: string
}

export class DatabaseConnections {
  readonly #saved = new Map<string, ReadonlyArray<DatabaseReference>>()

  saved(instanceId: string): ReadonlyArray<DatabaseReference> {
    return this.#saved.get(instanceId) ?? []
  }

  readonly #issues = new Map<string, Array<DatabaseConnectionIssue>>()

  issues(instanceId: string): ReadonlyArray<DatabaseConnectionIssue> {
    return this.#issues.get(instanceId) ?? []
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

  constructor(
    readonly config: RelayConfig,
    readonly state: RelayStateStore["Service"]
  ) {}

  async initialize(
    snapshots: ReadonlyArray<DatabaseConnectionSnapshot>
  ): Promise<void> {
    await this.#recover(snapshots)
    for (const snapshot of snapshots)
      this.#saved.set(
        snapshot.instanceId,
        await Effect.runPromise(
          this.state.listInstanceDatabaseConnections(snapshot.instanceId)
        )
      )
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
      // ID. Recover these even if a network vanished between ls and inspect.
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
          instanceId: snapshot.instanceId,
        }))
      )
    }
    await Effect.runPromise(this.state.recoverDatabaseConnections(recovered))
  }

  async labels(instanceId: string): Promise<Record<string, string>> {
    return databaseConnectionLabels(
      await Effect.runPromise(
        this.state.listInstanceDatabaseConnections(instanceId)
      )
    )
  }

  async set(
    instanceId: string,
    databaseId: string,
    connected: boolean,
    relayId = this.config.nodeId
  ): Promise<void> {
    // Persist intent first so a failed Docker operation can be retried safely.
    await Effect.runPromise(
      this.state.setDatabaseConnection(
        { instanceId, databaseId, relayId },
        connected
      )
    )
    const remaining = this.saved(instanceId).filter(
      (connection) =>
        connection.databaseId !== databaseId ||
        (!connected && connection.relayId !== relayId)
    )
    this.#saved.set(
      instanceId,
      connected ? [...remaining, { databaseId, relayId }] : remaining
    )
  }

  async forgetInstance(instanceId: string): Promise<void> {
    await Effect.runPromise(
      this.state.deleteInstanceDatabaseConnections(instanceId)
    )
    this.#issues.delete(instanceId)
    this.#saved.delete(instanceId)
  }

  async forgetDatabase(databaseId: string): Promise<void> {
    await Effect.runPromise(
      this.state.deleteDatabaseConnections(this.config.nodeId, databaseId)
    )
    for (const [instanceId, connections] of this.#saved)
      this.#saved.set(
        instanceId,
        connections.filter(
          (connection) =>
            connection.databaseId !== databaseId ||
            connection.relayId !== this.config.nodeId
        )
      )
    for (const [instanceId, issues] of this.#issues)
      this.#issues.set(
        instanceId,
        issues.filter((issue) => issue.databaseId !== databaseId)
      )
  }

  async reconcile(
    instanceId: string,
    service: string
  ): Promise<Array<DatabaseConnectionIssue>> {
    const issues: Array<DatabaseConnectionIssue> = []
    // Database attachments are optional to the container lifecycle. Report
    // discovery/inspection failures too, without discarding the saved intent.
    await recoverPromise(
      async () => {
        const connections = await Effect.runPromise(
          this.state.listInstanceDatabaseConnections(instanceId)
        )
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
        const inspected = await command("docker", [
          "inspect",
          "--format",
          "{{json .NetworkSettings.Networks}}",
          service,
        ])
        const attached = JSON.parse(inspected.stdout) as Record<string, unknown>
        for (const [databaseId, network] of networks) {
          const connect = desired.has(network)
          if (connect === Object.hasOwn(attached, network)) continue
          await recoverPromise(
            () =>
              command("docker", [
                "network",
                connect ? "connect" : "disconnect",
                network,
                service,
              ]),
            (cause) => {
              issues.push({
                databaseId,
                message: `Could not ${connect ? "connect" : "disconnect"} database: ${cause instanceof Error ? cause.message : String(cause)}`,
              })
            }
          )
        }
      },
      (cause) => {
        issues.push({
          databaseId: null,
          message: `Could not restore database connections: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    )
    this.#issues.set(instanceId, issues)
    for (const issue of issues)
      console.warn(
        `${service}: ${issue.databaseId ?? "databases"}: ${issue.message}`
      )
    return issues
  }

  async #networks(
    issues: Array<DatabaseConnectionIssue>
  ): Promise<Map<string, string>> {
    const listed = await command("docker", [
      "network",
      "ls",
      "--filter",
      "label=kiln.resource.kind=database",
      "--format",
      "{{.ID}}",
    ])
    const ids = listed.stdout.trim().split(/\s+/u).filter(Boolean)
    if (ids.length === 0) return new Map()
    const inspected = await Promise.all(
      ids.map((id) =>
        recoverPromise(
          async () => {
            const result = await command("docker", ["network", "inspect", id])
            return JSON.parse(result.stdout) as Array<DatabaseNetwork>
          },
          () => {
            issues.push({
              databaseId: null,
              message: `Could not inspect database network ${id}`,
            })
            return []
          }
        )
      )
    )
    const networks = inspected.flat()
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
