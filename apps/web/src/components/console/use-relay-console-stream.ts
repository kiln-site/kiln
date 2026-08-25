import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import type {
  RelayConsole,
  RelayConsoleLine,
  RelayInstanceLifecycleEvent,
  RelayInstanceLifecycleState,
  RelayObservedState,
} from "@workspace/contracts"
import { relayInstanceLifecycleEventTime as lifecycleEventTime } from "@workspace/contracts"

import {
  consoleRecoveryLine,
  consoleSessionAcceptedAheadOfRuntime,
  consoleSessionIsCurrent,
  consoleStateLine,
  initialConsoleStateLines,
  isConsoleRecoveryLine,
  isConsoleStateLine,
  isConsoleStateLineFor,
  mergeConsoleHistory,
  mergeConsoleStateLines,
  reconcileConsoleLifecycleLines,
  retimestampConsoleStateLine,
  shouldAwaitConsoleRecoverySession,
  shouldRecordConsoleStateTransition,
} from "@/components/console/console-lifecycle"
import type { ConsoleStreamSnapshot } from "@/components/console/console-stores"
import {
  openRelayConsoleStream,
  RelayConsoleConnectionError,
} from "@/lib/relay-console-stream"
import { queryKeys } from "@/lib/query-options"
import type { InstanceRuntime } from "@/lib/relay-selectors"

export function useRelayConsoleStream(
  relayId: string,
  instanceId: string,
  relayConnected: boolean,
  runtime: InstanceRuntime | null | undefined
) {
  const queryClient = useQueryClient()
  const hasEverBeenLiveRef = React.useRef(false)
  const runtimeRef = React.useRef(runtime)
  React.useLayoutEffect(() => {
    runtimeRef.current = runtime
  }, [runtime])
  const cachedConsole =
    queryClient.getQueryData<RelayConsole>(
      queryKeys.relay.console(relayId, instanceId)
    ) ?? null
  const consoleDataRef = React.useRef<RelayConsole | null>(
    consoleMatchesRuntime(cachedConsole, runtime) ? cachedConsole : null
  )
  const sessionStartedAtRef = React.useRef<string | null>(
    consoleDataRef.current?.startedAt ?? null
  )
  const sessionInitializedRef = React.useRef(Boolean(consoleDataRef.current))
  const awaitingNewSessionRef = React.useRef(false)
  const sessionAcceptedAheadOfRuntimeRef = React.useRef(false)
  const previousStateRef = React.useRef<RelayObservedState | undefined>(
    runtime?.observedState
  )
  const [snapshot, setSnapshot] = React.useState<ConsoleStreamSnapshot>(() => ({
    connection: relayConnected ? "opening" : "unavailable",
    consoleData: consoleDataRef.current,
    error: relayConnected ? null : "Hearth cannot reach this Relay right now.",
    loading: !consoleDataRef.current,
    transport: null,
    transportMessage: null,
  }))

  const commitConsole = React.useCallback(
    (next: RelayConsole) => {
      consoleDataRef.current = next
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        next
      )
      setSnapshot((current) =>
        updateConsoleStreamSnapshot(current, { consoleData: next })
      )
    },
    [instanceId, queryClient, relayId]
  )

  React.useEffect(() => {
    const state = runtime?.observedState
    const previous = previousStateRef.current
    if (!state) return

    const current = consoleDataRef.current
    if (
      state === "running" &&
      lifecycleEventTime(runtime.lifecycle, "started") ===
        sessionStartedAtRef.current
    ) {
      sessionAcceptedAheadOfRuntimeRef.current = false
    }
    const retimestampedLines = current
      ? retimestampRuntimeLifecycleLines(
          current.lines,
          current.startedAt,
          runtime.lifecycle
        )
      : null
    const currentWithTimestamps =
      current && retimestampedLines
        ? { ...current, lines: retimestampedLines }
        : current

    if (!shouldRecordConsoleStateTransition(previous, state)) {
      if (currentWithTimestamps && retimestampedLines) {
        commitConsole(currentWithTimestamps)
      }
      return
    }
    previousStateRef.current = state

    if (state === "starting") {
      if (
        currentWithTimestamps &&
        consoleSessionIsCurrent(
          awaitingNewSessionRef.current,
          sessionAcceptedAheadOfRuntimeRef.current,
          currentWithTimestamps.startedAt,
          lifecycleEventTime(runtime.lifecycle, "started")
        )
      ) {
        // The console stream can observe the replacement container before the
        // runtime snapshot. Keep its lines and only reconcile stale lifecycle
        // markers from the older snapshot.
        sessionInitializedRef.current = true
        commitConsole({
          ...currentWithTimestamps,
          lines: reconcileConsoleLifecycleLines(
            currentWithTimestamps.lines,
            runtime.lifecycle,
            state,
            runtime.recovery
          ),
        })
        return
      }
      awaitingNewSessionRef.current = true
      // Preserve the crashed session until Docker has actually started the
      // replacement process, so the failure context remains visible.
      if (runtime?.recovery?.phase === "pending") return
      const line = consoleStateLine(
        "starting",
        runtimeLifecycleTimestamp("starting", runtime.lifecycle) ??
          new Date().toISOString()
      )
      const next = {
        instanceId,
        lines: [line],
        startedAt: null,
        truncated: false,
      }
      sessionInitializedRef.current = true
      commitConsole(next)
      return
    }

    if (!sessionInitializedRef.current && previous === undefined) {
      if (currentWithTimestamps && retimestampedLines) {
        commitConsole(currentWithTimestamps)
      }
      return
    }
    if (!currentWithTimestamps) return
    const line = consoleStateLine(
      state,
      runtimeLifecycleTimestamp(state, runtime.lifecycle) ??
        new Date().toISOString()
    )
    if (
      currentWithTimestamps.lines.some((existing) =>
        isConsoleStateLineFor(existing, state)
      )
    ) {
      if (retimestampedLines) commitConsole(currentWithTimestamps)
      return
    }
    commitConsole({
      ...currentWithTimestamps,
      lines: mergeConsoleHistory(currentWithTimestamps.lines, [line]),
    })
  }, [
    commitConsole,
    instanceId,
    runtime?.lifecycle,
    runtime?.observedState,
    runtime?.recovery,
  ])

  React.useEffect(() => {
    const startedAt = lifecycleEventTime(runtime?.lifecycle ?? [], "started")
    if (
      !runtime ||
      !awaitingNewSessionRef.current ||
      !startedAt ||
      startedAt === sessionStartedAtRef.current
    ) {
      return
    }
    awaitingNewSessionRef.current = false
    sessionStartedAtRef.current = startedAt
    sessionInitializedRef.current = true
    commitConsole({
      instanceId,
      lines: initialConsoleStateLines(
        runtime.lifecycle,
        runtime.observedState,
        runtime.recovery
      ),
      startedAt,
      truncated: false,
    })
  }, [
    commitConsole,
    instanceId,
    runtime?.lifecycle,
    runtime?.observedState,
    runtime?.recovery,
  ])

  React.useEffect(() => {
    const recovery = runtime?.recovery
    if (!recovery) return
    if (
      shouldAwaitConsoleRecoverySession(
        recovery.phase,
        sessionAcceptedAheadOfRuntimeRef.current
      )
    ) {
      awaitingNewSessionRef.current = true
    }
    const current = consoleDataRef.current
    if (!current) return
    const line = consoleRecoveryLine(recovery, new Date().toISOString())
    if (current.lines.some((existing) => existing.id === line.id)) return
    commitConsole({
      ...current,
      lines: mergeConsoleHistory(current.lines, [line]),
    })
  }, [commitConsole, runtime?.recovery])

  React.useEffect(() => {
    if (!relayConnected) {
      setSnapshot((current) =>
        updateConsoleStreamSnapshot(current, {
          connection: "unavailable",
          error: "Hearth cannot reach this Relay right now.",
          loading: false,
        })
      )
      return
    }

    let cancelled = false
    const lifecycle = new AbortController()
    let activeIterator: ReturnType<typeof openRelayConsoleStream> | null = null
    let flushTimer: number | null = null
    const pending: Array<RelayConsoleLine> = []
    const seen = new Set(
      consoleDataRef.current?.lines.map((line) => line.id) ?? []
    )
    setSnapshot((current) =>
      updateConsoleStreamSnapshot(current, {
        connection: hasEverBeenLiveRef.current ? "reconnecting" : "opening",
        error: null,
        loading: !consoleDataRef.current,
      })
    )

    function commitSnapshot(patch: Partial<ConsoleStreamSnapshot>) {
      if (cancelled) return
      setSnapshot((current) => updateConsoleStreamSnapshot(current, patch))
    }

    function flush() {
      flushTimer = null
      if (cancelled || pending.length === 0) return
      const fresh = pending.splice(0).filter((line) => {
        if (seen.has(line.id)) return false
        seen.add(line.id)
        return true
      })
      if (fresh.length === 0) return
      const current = consoleDataRef.current
      const next = {
        instanceId,
        lines: capConsoleLines([...(current?.lines ?? []), ...fresh]),
        startedAt: current?.startedAt ?? sessionStartedAtRef.current,
        truncated: Boolean(current?.truncated) || seen.size > 5_000,
      }
      consoleDataRef.current = next
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        next
      )
      commitSnapshot({ consoleData: next })
    }

    function append(line: RelayConsoleLine) {
      pending.push(line)
      if (pending.length >= 100) flush()
      else if (flushTimer === null) {
        flushTimer = window.setTimeout(flush, 40)
      }
    }

    function replaceSession(
      startedAt: string | null,
      lines: ReadonlyArray<RelayConsoleLine>,
      truncated: boolean
    ) {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      pending.length = 0
      sessionAcceptedAheadOfRuntimeRef.current =
        consoleSessionAcceptedAheadOfRuntime(
          sessionAcceptedAheadOfRuntimeRef.current,
          sessionStartedAtRef.current,
          startedAt,
          runtimeRef.current?.observedState,
          lifecycleEventTime(runtimeRef.current?.lifecycle ?? [], "started")
        )
      // A reset is the authoritative session boundary. Runtime snapshots can
      // arrive later, but must not put an accepted session back into waiting.
      awaitingNewSessionRef.current = false
      sessionStartedAtRef.current = startedAt
      sessionInitializedRef.current = true
      const currentRuntime = runtimeRef.current
      const runtimeMatchesSession = Boolean(
        startedAt &&
        lifecycleEventTime(currentRuntime?.lifecycle ?? [], "started") ===
          startedAt
      )
      const nextLines = mergeConsoleStateLines(
        lines,
        runtimeMatchesSession
          ? (currentRuntime?.lifecycle ?? [])
          : startedAt
            ? [{ state: "started", time: startedAt }]
            : [],
        runtimeMatchesSession
          ? currentRuntime?.observedState
          : startedAt
            ? "starting"
            : currentRuntime?.observedState,
        runtimeMatchesSession ? (currentRuntime?.recovery ?? null) : null
      )
      seen.clear()
      for (const line of nextLines) seen.add(line.id)
      const nextConsole = {
        instanceId,
        lines: nextLines,
        startedAt,
        truncated,
      }
      consoleDataRef.current = nextConsole
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        nextConsole
      )
      commitSnapshot({ consoleData: nextConsole })
    }

    const connectFiber = Effect.runFork(
      Effect.gen(function* () {
        let retryDelay = 400
        while (!cancelled) {
          const failure = yield* Effect.tryPromise({
            try: async () => {
              const stream = openRelayConsoleStream(
                relayId,
                instanceId,
                lifecycle.signal
              )
              activeIterator = stream
              // Cancellation changes from the effect cleanup while next() awaits.
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              while (!cancelled) {
                const result = await activeIterator.next()
                // Cleanup can run while the iterator awaits its next event.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (cancelled) break
                if (result.done) throw new Error("Console stream closed")
                const event = result.value
                if (event.type === "transport") {
                  commitSnapshot({
                    error: null,
                    transport: event.transport,
                    transportMessage: event.message,
                  })
                } else if (event.type === "ready") {
                  hasEverBeenLiveRef.current = true
                  if (
                    awaitingNewSessionRef.current &&
                    event.startedAt !== undefined &&
                    event.startedAt !== sessionStartedAtRef.current
                  ) {
                    replaceSession(event.startedAt, [], false)
                  }
                  let nextConsole = consoleDataRef.current ?? {
                    instanceId,
                    lines: [],
                    startedAt: event.startedAt ?? null,
                    truncated: false,
                  }
                  const readyRuntime = runtimeRef.current
                  const readyStartedAt = readyRuntime
                    ? lifecycleEventTime(readyRuntime.lifecycle, "started")
                    : null
                  if (
                    readyRuntime &&
                    readyStartedAt &&
                    readyStartedAt === nextConsole.startedAt
                  ) {
                    nextConsole = {
                      ...nextConsole,
                      lines: reconcileConsoleLifecycleLines(
                        nextConsole.lines,
                        readyRuntime.lifecycle,
                        readyRuntime.observedState,
                        readyRuntime.recovery
                      ),
                    }
                  }
                  if (event.startedAt !== undefined) {
                    sessionStartedAtRef.current = event.startedAt
                  }
                  sessionInitializedRef.current = true
                  consoleDataRef.current = nextConsole
                  queryClient.setQueryData(
                    queryKeys.relay.console(relayId, instanceId),
                    nextConsole
                  )
                  commitSnapshot({
                    connection: "live",
                    consoleData: nextConsole,
                    error: null,
                    loading: false,
                  })
                  retryDelay = 400
                } else if (event.type === "reset") {
                  if (
                    awaitingNewSessionRef.current &&
                    event.startedAt === sessionStartedAtRef.current
                  ) {
                    continue
                  }
                  replaceSession(event.startedAt, event.lines, event.truncated)
                } else if (event.type === "history") {
                  if (
                    awaitingNewSessionRef.current ||
                    event.startedAt !== sessionStartedAtRef.current
                  ) {
                    continue
                  }
                  const fresh = event.lines.filter((line) => {
                    if (seen.has(line.id)) return false
                    seen.add(line.id)
                    return true
                  })
                  if (fresh.length === 0) continue
                  const current = consoleDataRef.current
                  if (!current) continue
                  const nextConsole = {
                    ...current,
                    lines: prependConsoleHistory(current.lines, fresh),
                    truncated: event.truncated,
                  }
                  consoleDataRef.current = nextConsole
                  queryClient.setQueryData(
                    queryKeys.relay.console(relayId, instanceId),
                    nextConsole
                  )
                  commitSnapshot({ consoleData: nextConsole })
                } else {
                  if (awaitingNewSessionRef.current) {
                    const startedAt = lifecycleEventTime(
                      runtimeRef.current?.lifecycle ?? [],
                      "started"
                    )
                    if (
                      !startedAt ||
                      startedAt === sessionStartedAtRef.current
                    ) {
                      continue
                    }
                    replaceSession(startedAt, [event.line], false)
                  } else {
                    append(event.line)
                  }
                }
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => null,
            })
          )
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (cancelled) break
          if (failure === null) continue
          commitSnapshot({
            connection: hasEverBeenLiveRef.current
              ? "reconnecting"
              : "unavailable",
            error: consoleConnectionMessage(failure),
            loading: false,
          })
          yield* Effect.sleep(retryDelay)
          retryDelay = Math.min(retryDelay * 2, 5_000)
        }
      })
    )

    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      flush()
      cancelled = true
      lifecycle.abort()
      if (activeIterator) void activeIterator.return(undefined)
      connectFiber.interruptUnsafe()
    }
  }, [instanceId, queryClient, relayConnected, relayId])

  return snapshot
}

function consoleMatchesRuntime(
  consoleData: RelayConsole | null,
  runtime: InstanceRuntime | null | undefined
): boolean {
  if (!consoleData) return false
  const expectedStartedAt = lifecycleEventTime(
    runtime?.lifecycle ?? [],
    "started"
  )
  return !expectedStartedAt || consoleData.startedAt === expectedStartedAt
}

function runtimeLifecycleTimestamp(
  state: RelayObservedState,
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>
): string | null {
  const lifecycleState = observedLifecycleState(state)
  return lifecycleState ? lifecycleEventTime(lifecycle, lifecycleState) : null
}

function retimestampRuntimeLifecycleLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  startedAt: string | null | undefined,
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>
): Array<RelayConsoleLine> | null {
  const sessionStartedAt = lifecycleEventTime(lifecycle, "started")
  if (sessionStartedAt && startedAt && sessionStartedAt !== startedAt) {
    return null
  }
  let next = [...lines]
  let changed = false
  for (const event of lifecycle) {
    const retimestamped = retimestampConsoleStateLine(
      next,
      lifecycleObservedState(event.state),
      event.time
    )
    if (!retimestamped) continue
    next = retimestamped
    changed = true
  }
  return changed ? next : null
}

function observedLifecycleState(
  state: RelayObservedState
): RelayInstanceLifecycleState | null {
  if (state === "starting") return "started"
  if (state === "running") return "ready"
  if (state === "stopping" || state === "stopped" || state === "failed") {
    return state
  }
  return null
}

function lifecycleObservedState(
  state: RelayInstanceLifecycleState
): RelayObservedState {
  if (state === "started") return "starting"
  if (state === "ready") return "running"
  return state
}

function prependConsoleHistory(
  current: ReadonlyArray<RelayConsoleLine>,
  history: ReadonlyArray<RelayConsoleLine>
): Array<RelayConsoleLine> {
  return capConsoleLines(mergeConsoleHistory(current, history))
}

function capConsoleLines(
  lines: ReadonlyArray<RelayConsoleLine>
): Array<RelayConsoleLine> {
  if (lines.length <= 5_008) return [...lines]
  let remaining = lines.length - 5_008
  return lines.filter((line) => {
    if (
      remaining === 0 ||
      isConsoleStateLine(line) ||
      isConsoleRecoveryLine(line)
    ) {
      return true
    }
    remaining -= 1
    return false
  })
}

function updateConsoleStreamSnapshot(
  current: ConsoleStreamSnapshot,
  patch: Partial<ConsoleStreamSnapshot>
): ConsoleStreamSnapshot {
  const next = { ...current, ...patch }
  return current.connection === next.connection &&
    current.consoleData === next.consoleData &&
    current.error === next.error &&
    current.loading === next.loading &&
    current.transport === next.transport &&
    current.transportMessage === next.transportMessage
    ? current
    : next
}

function consoleConnectionMessage(cause: unknown): string {
  if (cause instanceof RelayConsoleConnectionError) return cause.message
  return cause instanceof Error && cause.message
    ? cause.message
    : "The Relay is connected, but its console stream could not be read."
}
