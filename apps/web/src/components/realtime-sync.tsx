import * as React from "react"
import { useDbClient } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"

import {
  getRelayInstancesCollection,
  type RelayInstancesCollection,
} from "@/lib/collections/relay-instances"
import {
  authStateQueryOptions,
  queryKeys,
  type RelayConnection,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import {
  realtimeClientEventSchema,
  type FleetInstance,
  type RealtimeClientEvent,
} from "@/lib/realtime-events"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { getFreshRelaySnapshot } from "@/server/relay"

const maximumBufferedEvents = 256
const maximumRememberedEvents = 512
const maximumRecoveryRetryDelayMs = 30_000

export const RealtimeSync = React.memo(function RealtimeSync() {
  const dbClient = useDbClient()
  const queryClient = useQueryClient()

  React.useEffect(() => {
    const instances = getRelayInstancesCollection(dbClient)
    const source = new EventSource("/api/realtime")
    let closed = false
    let resetRequested = false
    let connectionRefetchRequested = false
    let resetting: Promise<void> | null = null
    let recoveryRetry: ReturnType<typeof setTimeout> | null = null
    let recoveryFailures = 0
    let activeEpoch: string | null = null
    let recoveryFloor = 0
    let checkingAuthentication: Promise<void> | null = null
    let bufferedEvents: Array<
      Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
    > = []
    const rememberedEvents = new Set<string>()
    const rememberedEventOrder: Array<string> = []

    const applyRecoverySnapshot = (snapshot: RelayFleetSnapshot): boolean => {
      if (closed) return false
      queryClient.setQueryData(queryKeys.relay.instances, snapshot.instances)
      queryClient.setQueryData(queryKeys.relay.snapshot, snapshot)
      queryClient.setQueryData<RelayConnection>(
        queryKeys.relay.connection,
        (connection) =>
          connection?.status === "connected"
            ? { ...connection, snapshot }
            : connection
      )
      return true
    }

    const rememberEvent = (
      event: Exclude<
        RealtimeClientEvent,
        { type: "relay.invalidate" | "reset" }
      >
    ): boolean => {
      const key = `${event.epoch}:${event.type}:${event.sequence}`
      if (rememberedEvents.has(key)) return false
      rememberedEvents.add(key)
      rememberedEventOrder.push(key)
      if (rememberedEventOrder.length > maximumRememberedEvents) {
        const oldest = rememberedEventOrder.shift()
        if (oldest) rememberedEvents.delete(oldest)
      }
      return true
    }

    const requestReset = (refetchConnection: boolean, sequence = 0) => {
      if (recoveryRetry) {
        clearTimeout(recoveryRetry)
        recoveryRetry = null
      }
      recoveryFloor = Math.max(recoveryFloor, sequence)
      resetRequested = true
      connectionRefetchRequested ||= refetchConnection
      if (resetting) return
      resetting = (async () => {
        while (!closed && resetRequested) {
          resetRequested = false
          const shouldRefetchConnection = connectionRefetchRequested
          connectionRefetchRequested = false
          const snapshotEpoch = activeEpoch
          if (closed) return
          const snapshot = reconcilePendingPowerSnapshot(
            await getFreshRelaySnapshot()
          )
          if (snapshotEpoch !== activeEpoch) continue
          if (!applyRecoverySnapshot(snapshot)) return
          recoveryFailures = 0
          if (shouldRefetchConnection) {
            await queryClient.refetchQueries({
              exact: true,
              queryKey: relayConnectionQueryOptions(queryClient).queryKey,
            })
          }
          // A newer reset supersedes events captured while this snapshot was
          // loading. Otherwise replay later deltas after the authoritative
          // snapshot so a slow response cannot overwrite fresh state.
          if (resetRequested) continue
          const replay = bufferedEvents.filter(
            (event) =>
              event.epoch === activeEpoch && event.sequence > recoveryFloor
          )
          bufferedEvents = []
          for (const event of replay) {
            applyRealtimeEvent({ event, instances, queryClient })
          }
        }
      })()
        .catch((cause) => {
          if (!closed) {
            console.warn("[Kiln realtime] Snapshot recovery failed", cause)
            const delay = Math.min(
              1_000 * 2 ** recoveryFailures,
              maximumRecoveryRetryDelayMs
            )
            recoveryFailures += 1
            recoveryRetry = setTimeout(() => {
              recoveryRetry = null
              requestReset(false)
            }, delay)
          }
        })
        .finally(() => {
          resetting = null
          if (!closed && resetRequested) requestReset(false)
        })
    }

    const handleEvent = (message: Event) => {
      if (!(message instanceof MessageEvent) || closed) return
      const parsed = realtimeClientEventSchema.safeParse(
        parseEventData(message.data)
      )
      if (!parsed.success) {
        requestReset(false)
        return
      }
      const event = parsed.data
      const epoch = resetRealtimeEpoch({
        currentEpoch: activeEpoch,
        nextEpoch: event.epoch,
        recoveryFloor,
      })
      const epochChanged = epoch.changed
      if (epochChanged) {
        activeEpoch = epoch.epoch
        recoveryFloor = epoch.recoveryFloor
        recoveryFailures = 0
        resetRequested = false
        connectionRefetchRequested = false
        bufferedEvents = []
        rememberedEvents.clear()
        rememberedEventOrder.length = 0
      }
      if (event.type === "reset") {
        if (event.clear) {
          applyRecoverySnapshot({ instances: [], nodes: [] })
        }
        requestReset(false, event.sequence)
        return
      }
      if (event.type === "relay.invalidate") {
        requestReset(true, event.sequence)
        return
      }
      if (event.sequence <= recoveryFloor) return
      if (!rememberEvent(event)) return
      if (epochChanged || resetting || resetRequested) {
        if (bufferedEvents.length >= maximumBufferedEvents) {
          bufferedEvents = []
          requestReset(false, event.sequence)
          return
        }
        bufferedEvents.push(event)
        if (epochChanged) requestReset(false)
        return
      }
      applyRealtimeEvent({ event, instances, queryClient })
    }
    const handleError = () => {
      if (closed || checkingAuthentication) return
      checkingAuthentication = queryClient
        .fetchQuery({ ...authStateQueryOptions(), staleTime: 0 })
        .then((auth) => {
          if (auth.user || closed) return
          closed = true
          source.close()
        })
        .catch(() => {
          // Transient network failures should keep EventSource's native retry.
        })
        .finally(() => {
          checkingAuthentication = null
        })
    }
    source.addEventListener("kiln", handleEvent)
    source.addEventListener("error", handleError)
    return () => {
      closed = true
      if (recoveryRetry) clearTimeout(recoveryRetry)
      source.removeEventListener("kiln", handleEvent)
      source.removeEventListener("error", handleError)
      source.close()
    }
  }, [dbClient, queryClient])

  return null
})

export function applyRealtimeEvent(input: {
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
  instances: RelayInstancesCollection
  queryClient: ReturnType<typeof useQueryClient>
}): void {
  const { event, instances, queryClient } = input
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) => applyRealtimeSnapshotEvent(snapshot, event)
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      connection?.status === "connected"
        ? {
            ...connection,
            snapshot:
              applyRealtimeSnapshotEvent(connection.snapshot, event) ??
              connection.snapshot,
          }
        : connection
  )
  if (event.type === "instances.delta") {
    instances.utils.writeBatch(() => {
      for (const item of event.upserted) {
        const key = `${item.relayId}:${item.id}`
        instances.utils.writeUpsert(
          mergeRealtimeInstance(
            instances.get(key) as FleetInstance | undefined,
            item
          )
        )
      }
      instances.utils.writeDelete(
        event.deleted.map(
          ({ instanceId, relayId }) => `${relayId}:${instanceId}`
        )
      )
    })
  }
}

export function applyRealtimeSnapshotEvent(
  snapshot: RelayFleetSnapshot | undefined,
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
): RelayFleetSnapshot | undefined {
  if (!snapshot) return snapshot
  if (event.type === "nodes.delta") {
    const nodes = new Map(event.nodes.map((node) => [node.relayId, node]))
    const nextNodes = snapshot.nodes.map((node) => {
      const updated = nodes.get(node.relayId)
      if (updated) nodes.delete(node.relayId)
      return updated ?? node
    })
    return { ...snapshot, nodes: [...nextNodes, ...nodes.values()] }
  }

  const deleted = new Set(
    event.deleted.map(({ instanceId, relayId }) => `${relayId}:${instanceId}`)
  )
  const upserted = new Map(
    event.upserted.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      instance,
    ])
  )
  const nextInstances = snapshot.instances.flatMap((instance) => {
    const key = `${instance.relayId}:${instance.id}`
    if (deleted.has(key)) return []
    const updated = upserted.get(key)
    if (updated) upserted.delete(key)
    return [updated ? mergeRealtimeInstance(instance, updated) : instance]
  })
  return {
    ...snapshot,
    instances: [...upserted.values(), ...nextInstances],
  }
}

export function mergeRealtimeInstance(
  current: FleetInstance | undefined,
  updated: FleetInstance
): FleetInstance {
  if (!current) return updated
  const endpointUnchanged =
    current.publicHost === updated.publicHost &&
    current.publicPort === updated.publicPort
  return {
    ...updated,
    connectAddress: endpointUnchanged
      ? current.connectAddress
      : updated.connectAddress,
  }
}

export function resetRealtimeEpoch(input: {
  currentEpoch: string | null
  nextEpoch: string
  recoveryFloor: number
}): { changed: boolean; epoch: string; recoveryFloor: number } {
  if (input.currentEpoch === input.nextEpoch) {
    return {
      changed: false,
      epoch: input.nextEpoch,
      recoveryFloor: input.recoveryFloor,
    }
  }
  return { changed: true, epoch: input.nextEpoch, recoveryFloor: 0 }
}

function parseEventData(data: unknown): unknown {
  if (typeof data !== "string") return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}
