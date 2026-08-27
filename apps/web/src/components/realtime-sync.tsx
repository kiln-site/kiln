import * as React from "react"
import { useDbClient } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import {
  authStateQueryOptions,
  queryKeys,
  type RelayConnection,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import { refreshHearthRealtimeTopics } from "@/lib/hearth-realtime"
import {
  type HearthRealtimeScope,
  hearthRealtimeTopics,
} from "@/lib/hearth-realtime-topics"
import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import {
  applyRealtimeEvent,
  parseRealtimeEventData,
  resetRealtimeEpoch,
} from "@/lib/realtime-client"
import {
  realtimeClientEventSchema,
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
    let hearthRefetchRequested = false
    let resetting: Promise<void> | null = null
    let recoveryRetry: ReturnType<typeof setTimeout> | null = null
    let recoveryFailures = 0
    let activeRecoveryConnection = false
    let activeRecoveryHearth = false
    let activeEpoch: string | null = null
    let recoveryFloor = 0
    let checkingAuthentication: Promise<void> | null = null
    let refreshingHearth: Promise<void> | null = null
    let hearthRefreshRetry: ReturnType<typeof setTimeout> | null = null
    let hearthRefreshFailures = 0
    const pendingHearthRefreshes = new Map<
      string,
      {
        scope?: HearthRealtimeScope
        topic: (typeof hearthRealtimeTopics)[number]
      }
    >()
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

    const requestHearthRefresh = (
      topics: ReadonlyArray<(typeof hearthRealtimeTopics)[number]>,
      scope?: HearthRealtimeScope
    ): Promise<void> => {
      for (const topic of topics) {
        const unscopedKey = `${topic}:*`
        if (!scope) {
          for (const key of pendingHearthRefreshes.keys()) {
            if (key.startsWith(`${topic}:`)) pendingHearthRefreshes.delete(key)
          }
          pendingHearthRefreshes.set(unscopedKey, { topic })
          continue
        }
        if (pendingHearthRefreshes.has(unscopedKey)) continue
        pendingHearthRefreshes.set(
          `${topic}:${scope.relayId}:${scope.instanceId ?? "*"}`,
          { scope, topic }
        )
      }
      if (refreshingHearth) return refreshingHearth
      if (hearthRefreshRetry) return Promise.resolve()
      const drainHearthRefreshes = (): Promise<void> => {
        if (closed || pendingHearthRefreshes.size === 0) {
          return Promise.resolve()
        }
        const next = [...pendingHearthRefreshes.values()]
        pendingHearthRefreshes.clear()
        return Promise.all(
          next.map(({ scope: nextScope, topic }) =>
            refreshHearthRealtimeTopics(queryClient, [topic], nextScope)
          )
        ).then(
          () => {
            hearthRefreshFailures = 0
            return drainHearthRefreshes()
          },
          (cause) => {
            for (const refresh of next) {
              void requestHearthRefresh([refresh.topic], refresh.scope)
            }
            if (!closed) {
              console.warn("[Kiln realtime] Hearth refresh failed", cause)
              const delay = Math.min(
                1_000 * 2 ** hearthRefreshFailures,
                maximumRecoveryRetryDelayMs
              )
              hearthRefreshFailures += 1
              hearthRefreshRetry = setTimeout(() => {
                hearthRefreshRetry = null
                void requestHearthRefresh([])
              }, delay)
            }
          }
        )
      }
      refreshingHearth = drainHearthRefreshes().finally(() => {
        refreshingHearth = null
        if (
          !closed &&
          !hearthRefreshRetry &&
          pendingHearthRefreshes.size > 0
        ) {
          void requestHearthRefresh([])
        }
      })
      return refreshingHearth
    }

    const requestReset = (
      refetchConnection: boolean,
      sequence = 0,
      refetchHearth = false
    ) => {
      if (recoveryRetry) {
        clearTimeout(recoveryRetry)
        recoveryRetry = null
      }
      recoveryFloor = Math.max(recoveryFloor, sequence)
      resetRequested = true
      connectionRefetchRequested ||= refetchConnection
      hearthRefetchRequested ||= refetchHearth
      if (resetting) return
      resetting = (async () => {
        while (!closed && resetRequested) {
          resetRequested = false
          const shouldRefetchConnection = connectionRefetchRequested
          const shouldRefetchHearth = hearthRefetchRequested
          connectionRefetchRequested = false
          hearthRefetchRequested = false
          activeRecoveryConnection = shouldRefetchConnection
          activeRecoveryHearth = shouldRefetchHearth
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
          if (shouldRefetchHearth) {
            await requestHearthRefresh(hearthRealtimeTopics)
          }
          activeRecoveryConnection = false
          activeRecoveryHearth = false
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
            applyRealtimeEvent({
              event,
              instances,
              queryClient,
              refreshTopics: requestHearthRefresh,
            })
          }
        }
      })()
        .catch((cause) => {
          if (!closed) {
            connectionRefetchRequested ||= activeRecoveryConnection
            hearthRefetchRequested ||= activeRecoveryHearth
            activeRecoveryConnection = false
            activeRecoveryHearth = false
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
        parseRealtimeEventData(message.data)
      )
      if (!parsed.success) {
        requestReset(false, 0, true)
        return
      }
      const event = parsed.data
      const initialEpoch = activeEpoch === null
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
        hearthRefetchRequested = false
        bufferedEvents = []
        rememberedEvents.clear()
        rememberedEventOrder.length = 0
      }
      if (event.type === "reset") {
        if (event.clear) {
          applyRecoverySnapshot({ instances: [], nodes: [] })
        }
        requestReset(
          false,
          event.sequence,
          event.hearth || (epochChanged && !initialEpoch)
        )
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
          requestReset(false, event.sequence, true)
          return
        }
        bufferedEvents.push(event)
        if (epochChanged) requestReset(false, 0, !initialEpoch)
        return
      }
      applyRealtimeEvent({
        event,
        instances,
        queryClient,
        refreshTopics: requestHearthRefresh,
      })
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
      if (hearthRefreshRetry) clearTimeout(hearthRefreshRetry)
      source.removeEventListener("kiln", handleEvent)
      source.removeEventListener("error", handleError)
      source.close()
    }
  }, [dbClient, queryClient])

  return null
})
