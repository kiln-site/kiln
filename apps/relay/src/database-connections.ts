import { databaseIdSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"

import { command } from "./command.js"
import type { RelayConfig } from "./config.js"
import {
  DATABASE_CONNECTION_RECOVERY_KEY,
  type RelayStateStore,
  type RelayStoredDatabaseConnection,
} from "./effect/state.js"
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

export class DatabaseConnections {
  constructor(
    readonly config: RelayConfig,
    readonly state: RelayStateStore["Service"]
  ) {}

  async initialize(
    snapshots: ReadonlyArray<DatabaseConnectionSnapshot>
  ): Promise<void> {
    if (
      await Effect.runPromise(
        this.state.getMetadata(DATABASE_CONNECTION_RECOVERY_KEY)
      )
    )
      return
    const networks = await this.#networks()
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
    connected: boolean
  ): Promise<void> {
    // Persist intent first so a failed Docker operation can be retried safely.
    await Effect.runPromise(
      this.state.setDatabaseConnection(
        { instanceId, databaseId, relayId: this.config.nodeId },
        connected
      )
    )
  }

  async forgetInstance(instanceId: string): Promise<void> {
    await Effect.runPromise(
      this.state.deleteInstanceDatabaseConnections(instanceId)
    )
  }

  async forgetDatabase(databaseId: string): Promise<void> {
    await Effect.runPromise(
      this.state.deleteDatabaseConnections(this.config.nodeId, databaseId)
    )
  }

  async reconcile(instanceId: string, service: string): Promise<void> {
    const connections = await Effect.runPromise(
      this.state.listInstanceDatabaseConnections(instanceId)
    )
    const networks = await this.#networks()
    const desired = new Set<string>()
    for (const connection of connections) {
      if (connection.relayId !== this.config.nodeId) continue
      const network = networks.get(connection.databaseId)
      if (!network)
        throw new Error(
          `Database ${connection.databaseId} network is unavailable on this Relay`
        )
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
    for (const network of networks.values()) {
      if (desired.has(network) && !Object.hasOwn(attached, network)) {
        await command("docker", ["network", "connect", network, service])
      } else if (!desired.has(network) && Object.hasOwn(attached, network)) {
        await command("docker", ["network", "disconnect", network, service])
      }
    }
  }

  async #networks(): Promise<Map<string, string>> {
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
    const inspected = await command("docker", ["network", "inspect", ...ids])
    const networks = JSON.parse(inspected.stdout) as Array<DatabaseNetwork>
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
      if (result.has(id.data))
        throw new Error(`Multiple networks found for database ${id.data}`)
      result.set(id.data, network.Name)
    }
    return result
  }
}
