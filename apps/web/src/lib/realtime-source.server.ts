import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import type { RelayInstance, RelaySnapshotDelta } from "@workspace/contracts"
import { Result } from "effect"

import type {
  HearthRealtimeAudience,
  HearthRealtimeScope,
  HearthRealtimeTopic,
} from "@/lib/hearth-realtime-topics"

export type RealtimeSourceChange =
  | {
      reauthenticate: boolean
      type: "access.changed"
      userIds: Array<string>
    }
  | {
      sessionIds: Array<string>
      type: "session.revoked"
    }
  | {
      audience: HearthRealtimeAudience
      scope?: HearthRealtimeScope
      topics: Array<HearthRealtimeTopic>
      type: "hearth.invalidate"
    }
  | {
      directoryChanged: boolean
      relayId: string
      type: "relay.snapshot.delta"
      delta: RelaySnapshotDelta
    }
  | { relayId: string; type: "relay.snapshot.reset" }
  | { relayId: string; type: "relay.metadata"; userIds?: Array<string> }
  | {
      relayId: string
      status: "connected" | "unreachable"
      type: "relay.state"
      updating: boolean
    }
  | {
      directoryChanged?: boolean
      relayId: string
      type: "instance.upsert"
      instance: RelayInstance
    }
  | { relayId: string; type: "instance.delete"; instanceId: string }

export type RealtimeSourceEvent = RealtimeSourceChange & {
  epoch: string
  sequence: number
}

export type RealtimeEventDelivery = "close" | "ignore" | "normal" | "ordered"

type RealtimeSourceListener = (event: RealtimeSourceEvent) => void

interface RealtimeSourceState {
  epoch: string
  listeners: Set<RealtimeSourceListener>
  sequence: number
}

declare global {
  var kilnRealtimeSourceState: RealtimeSourceState | undefined
}

const state = (globalThis.kilnRealtimeSourceState ??= {
  epoch: randomUUID(),
  listeners: new Set(),
  sequence: 0,
})
state.epoch ||= randomUUID()

export function publishRealtimeChange(
  change: RealtimeSourceChange
): RealtimeSourceEvent {
  const event = { ...change, epoch: state.epoch, sequence: ++state.sequence }
  for (const listener of state.listeners) {
    Result.try(() => listener(event)).pipe(
      Result.match({
        onFailure: (cause) =>
          console.error("[Kiln realtime] Event listener failed", cause),
        onSuccess: () => undefined,
      })
    )
  }
  return event
}

// Listeners run in the context they subscribed from, never the publisher's. A
// publisher is usually another user's request, and whatever a listener does
// there, such as Better Auth setting a cookie, lands on that user's response.
export function subscribeRealtimeChanges(
  listener: RealtimeSourceListener
): () => void {
  const runInSubscriberContext = AsyncLocalStorage.snapshot()
  const bound: RealtimeSourceListener = (event) =>
    runInSubscriberContext(listener, event)
  state.listeners.add(bound)
  return () => state.listeners.delete(bound)
}

export function allocateRealtimeCursor(): {
  epoch: string
  sequence: number
} {
  return { epoch: state.epoch, sequence: ++state.sequence }
}

export function classifyRealtimeEvent(
  event: RealtimeSourceEvent,
  identity: { sessionId: string | null; userId: string }
): RealtimeEventDelivery {
  if (event.type === "session.revoked") {
    return identity.sessionId && event.sessionIds.includes(identity.sessionId)
      ? "close"
      : "ignore"
  }
  if (event.type === "relay.metadata") return "ordered"
  if (event.type !== "access.changed") return "normal"
  if (!event.userIds.includes(identity.userId)) return "ignore"
  return event.reauthenticate ? "close" : "ordered"
}

export function realtimeSourceEventRefreshesHearth(event: {
  directoryChanged?: boolean
  type: RealtimeSourceEvent["type"]
}): boolean {
  if (
    event.type === "hearth.invalidate" ||
    event.type === "instance.delete" ||
    // Database inventory follows Relay reachability and update state.
    event.type === "relay.state"
  ) {
    return true
  }
  return (
    (event.type === "instance.upsert" ||
      event.type === "relay.snapshot.delta") &&
    event.directoryChanged === true
  )
}
