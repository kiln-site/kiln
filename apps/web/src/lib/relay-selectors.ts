import type { RelayServer, RelayNode } from "@workspace/contracts"
import {
  builtinTailscaleBrickId,
  relayServerLifecycleEventTime,
} from "@workspace/contracts"

import type { RelayConnection } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

export type RelayConnectionSummary =
  | Exclude<RelayConnection, { status: "connected" }>
  | Pick<
      Extract<RelayConnection, { status: "connected" }>,
      "relay" | "relays" | "status"
    >

/** A game server as navigation shows it: identity only, never live state. */
export type SidebarServer = Pick<
  RelayServer,
  "brickId" | "id" | "implementation" | "name" | "version"
> & {
  relayId: string
  relayName: string
}

export type ServerListEntry = Pick<
  RelayServer,
  | "brickId"
  | "connectAddress"
  | "game"
  | "id"
  | "implementation"
  | "name"
  | "observedState"
  | "provisioning"
  | "version"
> & {
  relayId: string
  relayName: string
  relayStatus: "connected" | "unreachable"
  relayUpdating?: boolean
}

export type WorkspaceServer = Pick<
  RelayServer,
  | "connectAddress"
  | "game"
  | "id"
  | "implementation"
  | "javaVersion"
  | "managedByRelay"
  | "name"
  | "observedState"
  | "pendingPrimaryPort"
  | "ports"
  | "publicHost"
  | "service"
  | "status"
  | "provisioning"
  | "version"
> & {
  relayId: string
  relayName: string
}

// What the file workspace needs of what it browses: a server, or an app's
// data directory (whose `id` is its file root, `app:<appId>`).
export type FileWorkspaceInstance = Pick<
  WorkspaceServer,
  "id" | "implementation" | "name" | "relayId" | "version"
> & { observedState?: RelayServer["observedState"] }

export type ServerRuntime = Pick<
  RelayServer,
  "id" | "lifecycle" | "observedState" | "recovery" | "resources"
> & { relayId: string }

export type SettingsServer = Pick<
  RelayServer,
  | "brickFormat"
  | "brickId"
  | "brickSource"
  | "connectAddress"
  | "containerId"
  | "directory"
  | "game"
  | "hostDirectory"
  | "id"
  | "implementation"
  | "javaVersion"
  | "limits"
  | "name"
  | "pendingLimits"
  | "ports"
  | "provisioning"
  | "publicHost"
  | "publicPort"
  | "service"
  | "version"
> & { relayId: string }

export type RelayNodeSummary = Pick<RelayNode, "id" | "name">

export interface ServerSettingsData {
  instance: SettingsServer
  node: RelayNodeSummary
}

export function selectRelayConnectionSummary(
  connection: RelayConnection
): RelayConnectionSummary {
  return connection.status === "connected"
    ? {
        relay: connection.relay,
        relays: connection.relays,
        status: connection.status,
      }
    : connection
}

export function selectSidebarServers(
  snapshot: RelayFleetSnapshot
): Array<SidebarServer> {
  const instances: Array<SidebarServer> = []
  for (const instance of snapshot.instances) {
    if (isServerInstance(instance)) instances.push(sidebarInstance(instance))
  }
  return instances
}

export function selectSidebarServerCount(snapshot: RelayFleetSnapshot): number {
  let count = 0
  for (const instance of snapshot.instances) {
    if (isServerInstance(instance)) count += 1
  }
  return count
}

// How many servers one Relay runs, and how many of those are running.
export function selectRelayServerCount(relayId: string) {
  return (snapshot: RelayFleetSnapshot): number => {
    let total = 0
    for (const instance of snapshot.instances) {
      if (instance.relayId === relayId && isServerInstance(instance)) total += 1
    }
    return total
  }
}

function sidebarInstance(
  instance: RelayFleetSnapshot["instances"][number]
): SidebarServer {
  return {
    brickId: instance.brickId,
    id: instance.id,
    implementation: instance.implementation,
    name: instance.name,
    relayId: instance.relayId,
    relayName: instance.relayName,
    version: instance.version,
  }
}

function isServerInstance(
  instance: RelayFleetSnapshot["instances"][number]
): boolean {
  return instance.brickId !== builtinTailscaleBrickId
}

export function selectRelayConfigured(connection: RelayConnection): boolean {
  return connection.status !== "unconfigured" && connection.status !== "paused"
}

export function selectRelayConnected(relayId: string) {
  return (connection: RelayConnection): boolean =>
    connection.status === "connected" &&
    (connection.relays.some(
      (relay) => relay.id === relayId && relay.status === "connected"
    ) ||
      (connection.relays.length === 0 && connection.relay?.id === relayId))
}

export function selectRelayBrowserOrigin(relayId: string) {
  return (connection: RelayConnection): string | null => {
    if (connection.status === "unconfigured") return null
    return (
      connection.relays.find((relay) => relay.id === relayId)?.browserOrigin ??
      null
    )
  }
}

export function selectRelayConsoleTransport(relayId: string) {
  return (connection: RelayConnection): "direct" | "hearth" | null => {
    if (connection.status === "unconfigured") return null
    return (
      connection.relays.find((relay) => relay.id === relayId)
        ?.consoleTransport ?? null
    )
  }
}

export function selectWorkspaceServer(identifier: string) {
  return (snapshot: RelayFleetSnapshot): WorkspaceServer | null => {
    const instance = findRelayServer(snapshot.instances, identifier)
    if (!instance) return null
    return {
      connectAddress: instance.connectAddress,
      game: instance.game,
      id: instance.id,
      implementation: instance.implementation,
      javaVersion: instance.javaVersion,
      managedByRelay: instance.managedByRelay,
      name: instance.name,
      observedState: instance.observedState,
      pendingPrimaryPort: instance.pendingPrimaryPort,
      ports: instance.ports,
      publicHost: instance.publicHost,
      relayId: instance.relayId,
      relayName: instance.relayName,
      service: instance.service,
      status: instance.status,
      provisioning: instance.provisioning,
      version: instance.version,
    }
  }
}

export type ConsoleServerRuntime = Omit<ServerRuntime, "resources">

export function selectServerConsoleRuntime(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot): ConsoleServerRuntime | null => {
    const instance = snapshot.instances.find(
      (item) => item.id === instanceId && (!relayId || item.relayId === relayId)
    )
    return instance
      ? {
          id: instance.id,
          lifecycle: instance.lifecycle,
          observedState: instance.observedState,
          recovery: instance.recovery,
          relayId: instance.relayId,
        }
      : null
  }
}

export function selectServerSettings(instanceId: string, relayId?: string) {
  return (snapshot: RelayFleetSnapshot): ServerSettingsData | null => {
    const instance = snapshot.instances.find(
      (item) => item.id === instanceId && (!relayId || item.relayId === relayId)
    )
    if (!instance) return null
    return {
      instance: {
        brickFormat: instance.brickFormat,
        brickId: instance.brickId,
        brickSource: instance.brickSource,
        connectAddress: instance.connectAddress,
        containerId: instance.containerId,
        directory: instance.directory,
        game: instance.game,
        hostDirectory: instance.hostDirectory,
        id: instance.id,
        implementation: instance.implementation,
        javaVersion: instance.javaVersion,
        limits: instance.limits,
        name: instance.name,
        pendingLimits: instance.pendingLimits,
        ports: instance.ports,
        provisioning: instance.provisioning,
        publicHost: instance.publicHost,
        publicPort: instance.publicPort,
        relayId: instance.relayId,
        service: instance.service,
        version: instance.version,
      },
      node: (() => {
        const node = snapshot.nodes.find(
          (item) => item.relayId === instance.relayId
        )
        return {
          id: node?.id ?? instance.relayId,
          name: node?.name ?? instance.relayName,
        }
      })(),
    }
  }
}

// Whether a game server is running, so saved limits wait on a restart or a
// start, and the files a disk limit has to hold, rounded so usage ticking up
// doesn't render the section.
export function selectServerLimitsState(instanceId: string, relayId?: string) {
  return (snapshot: RelayFleetSnapshot) => {
    const instance = snapshot.instances.find(
      (candidate) =>
        candidate.id === instanceId &&
        (!relayId || candidate.relayId === relayId)
    )
    const usedBytes = instance?.resources?.storage.usedBytes ?? null
    return {
      diskUsedBytes:
        usedBytes === null
          ? null
          : Math.ceil(usedBytes / DISK_USED_ROUNDING) * DISK_USED_ROUNDING,
      running:
        instance?.desiredState === "running" ||
        ["running", "starting", "stopping"].includes(
          instance?.observedState ?? ""
        ),
    }
  }
}

const DISK_USED_ROUNDING = 64 * 1024 ** 2

export function selectServerObservedState(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.find(
      (instance) =>
        instance.id === instanceId && (!relayId || instance.relayId === relayId)
    )?.observedState ?? null
}

export function selectServerStateReason(instanceId: string, relayId?: string) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.find(
      (instance) =>
        instance.id === instanceId && (!relayId || instance.relayId === relayId)
    )?.stateReason ?? null
}

export function selectServerLifecycleStartedAt(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) => {
    const instance = snapshot.instances.find(
      (item) => item.id === instanceId && (!relayId || item.relayId === relayId)
    )
    return relayServerLifecycleEventTime(instance?.lifecycle, "started")
  }
}

export function selectServerContainerRunning(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.some(
      (instance) =>
        instance.id === instanceId &&
        (!relayId || instance.relayId === relayId) &&
        relayServerLifecycleEventTime(instance.lifecycle, "started") !==
          null &&
        (instance.observedState === "starting" ||
          instance.observedState === "running" ||
          instance.observedState === "stopping")
    )
}

/**
 * The game server an ID names. An instance ID is unique across every Relay,
 * so it names one server however many Relays the fleet has.
 */
export function findRelayServer<T extends { id: string }>(
  instances: ReadonlyArray<T>,
  id: string | null | undefined
): T | undefined {
  return id ? instances.find((instance) => instance.id === id) : undefined
}
