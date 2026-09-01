import type { RelayInstance, RelayNode } from "@workspace/contracts"
import {
  builtinTailscaleBrickId,
  relayInstanceLifecycleEventTime,
} from "@workspace/contracts"

import type { RelayConnection } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

export type RelayConnectionSummary =
  | Exclude<RelayConnection, { status: "connected" }>
  | Pick<
      Extract<RelayConnection, { status: "connected" }>,
      "relay" | "relays" | "status"
    >

export type SidebarInstance = Pick<
  RelayInstance,
  | "brickId"
  | "brickSource"
  | "id"
  | "implementation"
  | "name"
  | "observedState"
  | "shortId"
  | "version"
> & {
  relayId: string
  relayName: string
  routeId: string
}

export type RouteInstance = SidebarInstance & {
  relayStatus: "connected" | "unreachable"
}

export type ServerListInstance = Pick<
  RelayInstance,
  | "brickId"
  | "connectAddress"
  | "game"
  | "id"
  | "implementation"
  | "name"
  | "observedState"
  | "provisioning"
  | "shortId"
  | "version"
> & {
  relayId: string
  relayName: string
  relayStatus: "connected" | "unreachable"
  routeId: string
}

export type InstanceWorkspaceInstance = Pick<
  RelayInstance,
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
  | "shortId"
  | "status"
  | "provisioning"
  | "version"
> & {
  relayId: string
  relayName: string
  routeId: string
}

export type InstanceRuntime = Pick<
  RelayInstance,
  "id" | "lifecycle" | "observedState" | "recovery" | "resources"
> & { relayId: string }

export type InstanceSettingsInstance = Pick<
  RelayInstance,
  | "brickFormat"
  | "brickId"
  | "brickSource"
  | "connectAddress"
  | "containerId"
  | "directory"
  | "game"
  | "id"
  | "implementation"
  | "javaVersion"
  | "name"
  | "provisioning"
  | "publicHost"
  | "publicPort"
  | "service"
  | "shortId"
  | "version"
> & { relayId: string; routeId: string }

export type RelayNodeSummary = Pick<RelayNode, "id" | "name">

export interface InstanceSettingsData {
  instance: InstanceSettingsInstance
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

export function selectSidebarInstances(
  snapshot: RelayFleetSnapshot
): Array<SidebarInstance> {
  const instances: Array<SidebarInstance> = []
  for (const instance of snapshot.instances) {
    if (isServerInstance(instance)) instances.push(sidebarInstance(instance))
  }
  return instances
}

export function selectSidebarInstanceCount(
  snapshot: RelayFleetSnapshot
): number {
  let count = 0
  for (const instance of snapshot.instances) {
    if (isServerInstance(instance)) count += 1
  }
  return count
}

export function selectRouteInstances(
  snapshot: RelayFleetSnapshot
): Array<RouteInstance> {
  return snapshot.instances.map((instance) => ({
    ...sidebarInstance(instance),
    relayStatus: instance.relayStatus,
  }))
}

export function selectServerListInstances(
  snapshot: RelayFleetSnapshot
): Array<ServerListInstance> {
  return snapshot.instances.map((instance) => ({
    brickId: instance.brickId,
    connectAddress: instance.connectAddress,
    game: instance.game,
    id: instance.id,
    implementation: instance.implementation,
    name: instance.name,
    observedState: instance.observedState,
    provisioning: instance.provisioning,
    relayId: instance.relayId,
    relayName: instance.relayName,
    relayStatus: instance.relayStatus,
    routeId: instance.routeId,
    shortId: instance.shortId,
    version: instance.version,
  }))
}

function sidebarInstance(
  instance: RelayFleetSnapshot["instances"][number]
): SidebarInstance {
  return {
    brickId: instance.brickId,
    brickSource: instance.brickSource,
    id: instance.id,
    implementation: instance.implementation,
    name: instance.name,
    observedState: instance.observedState,
    relayId: instance.relayId,
    relayName: instance.relayName,
    routeId: instance.routeId,
    shortId: instance.shortId,
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

export function selectInstanceWorkspaceInstance(identifier: string) {
  return (snapshot: RelayFleetSnapshot): InstanceWorkspaceInstance | null => {
    const instance = findRelayInstance(snapshot.instances, identifier)
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
      routeId: instance.routeId,
      service: instance.service,
      shortId: instance.shortId,
      status: instance.status,
      provisioning: instance.provisioning,
      version: instance.version,
    }
  }
}

export function selectInstanceRelayConnected(
  identifier: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot): boolean =>
    snapshot.instances.find(
      (instance) =>
        (!relayId || instance.relayId === relayId) &&
        (instance.routeId === identifier ||
          instance.shortId === identifier ||
          instance.id === identifier ||
          instance.name === identifier)
    )?.relayStatus === "connected"
}

export function selectInstanceRuntime(instanceId: string, relayId?: string) {
  return (snapshot: RelayFleetSnapshot): InstanceRuntime | null => {
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
          resources: instance.resources,
        }
      : null
  }
}

export function selectInstanceSettings(instanceId: string, relayId?: string) {
  return (snapshot: RelayFleetSnapshot): InstanceSettingsData | null => {
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
        id: instance.id,
        implementation: instance.implementation,
        javaVersion: instance.javaVersion,
        name: instance.name,
        provisioning: instance.provisioning,
        publicHost: instance.publicHost,
        publicPort: instance.publicPort,
        relayId: instance.relayId,
        routeId: instance.routeId,
        service: instance.service,
        shortId: instance.shortId,
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

export function selectInstanceObservedState(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.find(
      (instance) =>
        instance.id === instanceId && (!relayId || instance.relayId === relayId)
    )?.observedState ?? null
}

export function selectInstanceStateReason(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.find(
      (instance) =>
        instance.id === instanceId && (!relayId || instance.relayId === relayId)
    )?.stateReason ?? null
}

export function selectInstanceLifecycleStartedAt(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) => {
    const instance = snapshot.instances.find(
      (item) => item.id === instanceId && (!relayId || item.relayId === relayId)
    )
    return relayInstanceLifecycleEventTime(instance?.lifecycle, "started")
  }
}

export function selectInstanceContainerRunning(
  instanceId: string,
  relayId?: string
) {
  return (snapshot: RelayFleetSnapshot) =>
    snapshot.instances.some(
      (instance) =>
        instance.id === instanceId &&
        (!relayId || instance.relayId === relayId) &&
        relayInstanceLifecycleEventTime(instance.lifecycle, "started") !==
          null &&
        (instance.observedState === "starting" ||
          instance.observedState === "running" ||
          instance.observedState === "stopping")
    )
}

export function findRelayInstance<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(instances: Array<T>, identifier: string | null | undefined): T | undefined {
  const resolution = resolveRelayInstance(instances, identifier)
  return resolution.status === "found" ? resolution.instance : undefined
}

export type RelayInstanceResolution<T> =
  | { status: "ambiguous" }
  | { status: "found"; instance: T }
  | { status: "not-found" }

export function resolveRelayInstance<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(
  instances: Array<T>,
  identifier: string | null | undefined
): RelayInstanceResolution<T> {
  if (!identifier) return { status: "not-found" }
  if (/^[a-f0-9]{8}$/u.test(identifier)) {
    return resolveRelayInstanceMatches(
      instances.filter((instance) => instance.shortId === identifier)
    )
  }

  const routeIdMatches = instances.filter(
    (instance) => instance.routeId === identifier
  )
  if (routeIdMatches.length > 0) {
    return resolveRelayInstanceMatches(routeIdMatches)
  }

  const idMatches = instances.filter((instance) => instance.id === identifier)
  if (idMatches.length > 0) return resolveRelayInstanceMatches(idMatches)

  return resolveRelayInstanceMatches(
    instances.filter((instance) => instance.name === identifier)
  )
}

export function resolveCanonicalRelayInstance<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(
  instances: Array<T>,
  identifier: string | null | undefined
): RelayInstanceResolution<T> {
  const resolution = resolveRelayInstance(instances, identifier)
  if (resolution.status !== "found") return resolution

  return relayInstanceRouteIdentifier(instances, resolution.instance)
    ? resolution
    : { status: "ambiguous" }
}

export function relayInstanceRouteIdentifier<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(instances: Array<T>, instance: T): string | undefined {
  const shortIdResolution = resolveRelayInstance(instances, instance.shortId)
  if (shortIdResolution.status === "found") return instance.shortId
  if (!instance.routeId) return undefined

  const routeIdResolution = resolveRelayInstance(instances, instance.routeId)
  return routeIdResolution.status === "found" ? instance.routeId : undefined
}

export function findFirstCanonicalRelayInstance<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(instances: Array<T>): T | undefined {
  return instances.find((instance) =>
    relayInstanceRouteIdentifier(instances, instance)
  )
}

function resolveRelayInstanceMatches<T>(
  matches: Array<T>
): RelayInstanceResolution<T> {
  if (matches.length === 0) return { status: "not-found" }
  const instance = matches[0]
  return matches.length === 1 && instance
    ? { status: "found", instance }
    : { status: "ambiguous" }
}
