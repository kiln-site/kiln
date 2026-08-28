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
    }
  | { relayId: string; type: "instance.upsert"; instance: RelayInstance }
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

export function subscribeRealtimeChanges(
  listener: RealtimeSourceListener
): () => void {
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
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
