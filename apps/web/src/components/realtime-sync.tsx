import * as React from "react"
import { useDbClient } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"

import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import {
  authStateQueryOptions,
  type RelayConnection,
} from "@/lib/query-options"
import { refreshHearthRealtimeTopics } from "@/lib/hearth-realtime"
import {
  type HearthRealtimeScope,
  hearthRealtimeTopics,
} from "@/lib/hearth-realtime-topics"
import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import {
  applyRecoveredRelayConnection,
  applyRealtimeEventSafely,
  parseRealtimeEventData,
  resetRealtimeEpoch,
} from "@/lib/realtime-client"
import {
  realtimeHeartbeatIntervalMs,
  realtimeStreamIsStale,
} from "@/lib/realtime-heartbeat"
import {
  realtimeClientEventSchema,
  type RealtimeClientEvent,
} from "@/lib/realtime-events"
import { getFreshRelayConnectionState } from "@/server/relay"
import { notifyRelayBrowserAuthorizationChanged } from "@/lib/relay-browser-credentials"

const maximumBufferedEvents = 256
const maximumRememberedEvents = 512
const maximumRecoveryRetryDelayMs = 30_000

export const RealtimeSync = React.memo(function RealtimeSync() {
  const dbClient = useDbClient()
  const queryClient = useQueryClient()

  // The cleanup closes EventSource and clears every retry/watchdog timer;
  // async work also observes `closed` before applying results.
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup
  React.useEffect(() => {
    const instances = getRelayInstancesCollection(dbClient)
    let source: EventSource | null = null
    let closed = false
    let resetRequested = false
    let hearthRefetchRequested = false
    let authorizationRefreshRequested = false
    let resetting: Promise<void> | null = null
    let recoveryRetry: ReturnType<typeof setTimeout> | null = null
    let recoveryFailures = 0
    let activeRecoveryHearth = false
    let activeEpoch: string | null = null
    let recoveryFloor = 0
    let checkingAuthentication: Promise<void> | null = null
    let refreshingHearth: Promise<void> | null = null
    let hearthRefreshRetry: ReturnType<typeof setTimeout> | null = null
    let hearthRefreshFailures = 0
    let lastStreamActivityAt = Date.now()
    let streamWatchdog: ReturnType<typeof setInterval> | null = null
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

    const applyRecoveryConnection = async (
      connection: RelayConnection
    ): Promise<boolean> => {
      if (closed) return false
      const recoveredConnection =
        connection.status === "connected" || connection.status === "unreachable"
          ? {
              ...connection,
              snapshot: reconcilePendingPowerSnapshot(connection.snapshot),
            }
          : connection
      await applyRecoveredRelayConnection(queryClient, recoveredConnection)
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
          `${topic}:${scope.relayId}:${scope.instanceId ?? "*"}:${scope.databaseId ?? "*"}`,
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
        const grouped = new Map<
          string,
          {
            scope?: HearthRealtimeScope
            topics: Array<(typeof hearthRealtimeTopics)[number]>
          }
        >()
        for (const refresh of next) {
          const key = refresh.scope
            ? `${refresh.scope.relayId}:${refresh.scope.instanceId ?? "*"}:${refresh.scope.databaseId ?? "*"}`
            : "*"
          const group = grouped.get(key) ?? {
            ...(refresh.scope ? { scope: refresh.scope } : {}),
            topics: [],
          }
          group.topics.push(refresh.topic)
          grouped.set(key, group)
        }
        return recoverPromise(
          () =>
            Promise.all(
              [...grouped.values()].map(({ scope: nextScope, topics }) =>
                refreshHearthRealtimeTopics(queryClient, topics, nextScope)
              )
            ).then(() => {
              hearthRefreshFailures = 0
              return drainHearthRefreshes()
            }),
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
      refreshingHearth = ensuringPromise(drainHearthRefreshes, () => {
        refreshingHearth = null
        if (!closed && !hearthRefreshRetry && pendingHearthRefreshes.size > 0) {
          void requestHearthRefresh([])
        }
      })
      return refreshingHearth
    }

    const requestReset = (
      sequence = 0,
      refetchHearth = false,
      refreshAuthorization = false
    ) => {
      if (recoveryRetry) {
        clearTimeout(recoveryRetry)
        recoveryRetry = null
      }
      recoveryFloor = Math.max(recoveryFloor, sequence)
      resetRequested = true
      hearthRefetchRequested ||= refetchHearth
      authorizationRefreshRequested ||= refreshAuthorization
      if (resetting) return
      resetting = ensuringPromise(
        () =>
          recoverPromise(
            async () => {
              while (!closed && resetRequested) {
                resetRequested = false
                const shouldRefetchHearth = hearthRefetchRequested
                const shouldRefreshAuthorization = authorizationRefreshRequested
                hearthRefetchRequested = false
                authorizationRefreshRequested = false
                if (shouldRefreshAuthorization) {
                  notifyRelayBrowserAuthorizationChanged()
                }
                activeRecoveryHearth = shouldRefetchHearth
                const recoveryEpoch = activeEpoch
                if (closed) return
                const connection = await getFreshRelayConnectionState()
                if (recoveryEpoch !== activeEpoch) continue
                if (resetRequested) {
                  hearthRefetchRequested ||= shouldRefetchHearth
                  authorizationRefreshRequested ||= shouldRefreshAuthorization
                  activeRecoveryHearth = false
                  continue
                }
                if (!(await applyRecoveryConnection(connection))) return
                recoveryFailures = 0
                if (resetRequested) {
                  hearthRefetchRequested ||= shouldRefetchHearth
                  authorizationRefreshRequested ||= shouldRefreshAuthorization
                  activeRecoveryHearth = false
                  continue
                }
                if (shouldRefetchHearth) {
                  await requestHearthRefresh(hearthRealtimeTopics)
                }
                activeRecoveryHearth = false
                // A newer reset supersedes events captured while this snapshot
                // was loading. Otherwise replay later deltas after the
                // authoritative snapshot so a slow response cannot overwrite
                // fresh state.
                if (resetRequested) continue
                const replay = bufferedEvents.filter(
                  (event) =>
                    event.epoch === activeEpoch &&
                    event.sequence > recoveryFloor
                )
                bufferedEvents = []
                for (const event of replay) {
                  if (!applyEventOrRecover(event)) break
                }
              }
            },
            (cause) => {
              if (!closed) {
                hearthRefetchRequested ||= activeRecoveryHearth
                activeRecoveryHearth = false
                console.warn("[Kiln realtime] Relay recovery failed", cause)
                const delay = Math.min(
                  1_000 * 2 ** recoveryFailures,
                  maximumRecoveryRetryDelayMs
                )
                recoveryFailures += 1
                recoveryRetry = setTimeout(() => {
                  recoveryRetry = null
                  requestReset()
                }, delay)
              }
            }
          ),
        () => {
          resetting = null
          if (!closed && resetRequested) requestReset()
        }
      )
    }

    const applyEventOrRecover = (
      event: Exclude<
        RealtimeClientEvent,
        { type: "relay.invalidate" | "reset" }
      >
    ): boolean =>
      applyRealtimeEventSafely(
        {
          event,
          instances,
          queryClient,
          refreshTopics: requestHearthRefresh,
        },
        (cause) => {
          console.warn("[Kiln realtime] Could not apply event", cause)
          requestReset(event.sequence, true)
        }
      )

    const handleEvent = (message: Event) => {
      if (!(message instanceof MessageEvent) || closed) return
      lastStreamActivityAt = Date.now()
      const parsed = realtimeClientEventSchema.safeParse(
        parseRealtimeEventData(message.data)
      )
      if (!parsed.success) {
        requestReset(0, true)
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
        hearthRefetchRequested = false
        authorizationRefreshRequested = false
        bufferedEvents = []
        rememberedEvents.clear()
        rememberedEventOrder.length = 0
      }
      if (event.type === "reset") {
        if (event.clear) {
          void applyRecoveryConnection({
            message: "No Relay has been configured yet.",
            relay: null,
            status: "unconfigured",
          })
        }
        requestReset(
          event.sequence,
          event.hearth || (epochChanged && !initialEpoch),
          event.authorization === true
        )
        return
      }
      if (event.type === "relay.invalidate") {
        if (event.topics) {
          void requestHearthRefresh(event.topics, event.scope)
        }
        requestReset(event.sequence)
        return
      }
      if (event.sequence <= recoveryFloor) return
      if (!rememberEvent(event)) return
      if (epochChanged || resetting || resetRequested) {
        if (bufferedEvents.length >= maximumBufferedEvents) {
          bufferedEvents = []
          requestReset(event.sequence, true)
          return
        }
        bufferedEvents.push(event)
        if (epochChanged) requestReset(0, !initialEpoch)
        return
      }
      applyEventOrRecover(event)
    }
    const handleActivity = () => {
      if (!closed) lastStreamActivityAt = Date.now()
    }
    const handleError = () => {
      if (closed || checkingAuthentication) return
      checkingAuthentication = ensuringPromise(
        () =>
          recoverPromise(
            () =>
              queryClient
                .fetchQuery({ ...authStateQueryOptions(), staleTime: 0 })
                .then((auth) => {
                  if (auth.user || closed) return
                  closed = true
                  disconnectSource()
                }),
            () => undefined
          ),
        () => {
          checkingAuthentication = null
        }
      )
    }
    const disconnectSource = () => {
      const activeSource = source
      if (!activeSource) return
      source = null
      activeSource.removeEventListener("kiln", handleEvent)
      activeSource.removeEventListener("open", handleActivity)
      activeSource.removeEventListener("ping", handleActivity)
      activeSource.removeEventListener("error", handleError)
      activeSource.close()
    }
    const connectSource = () => {
      if (closed) return
      const nextSource = new EventSource("/api/realtime")
      source = nextSource
      lastStreamActivityAt = Date.now()
      nextSource.addEventListener("kiln", handleEvent)
      nextSource.addEventListener("open", handleActivity)
      nextSource.addEventListener("ping", handleActivity)
      nextSource.addEventListener("error", handleError)
    }
    connectSource()
    streamWatchdog = setInterval(() => {
      if (closed || !realtimeStreamIsStale(lastStreamActivityAt, Date.now())) {
        return
      }
      console.warn("[Kiln realtime] Stream heartbeat timed out; reconnecting")
      disconnectSource()
      connectSource()
    }, realtimeHeartbeatIntervalMs)
    return () => {
      closed = true
      if (recoveryRetry) clearTimeout(recoveryRetry)
      if (hearthRefreshRetry) clearTimeout(hearthRefreshRetry)
      if (streamWatchdog) clearInterval(streamWatchdog)
      disconnectSource()
    }
  }, [dbClient, queryClient])

  return null
})
