import type { AuthenticatedUser } from "@/lib/auth-session"
import { accountSessionActiveEffect } from "@/effect/account-sessions"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  visibleRelaysForUser,
} from "@/lib/access-control"
import { roleHasPermission } from "@/lib/permissions"
import { relayConnectionState } from "@/lib/relay-connection"
import {
  allocateRealtimeCursor,
  classifyRealtimeEvent,
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "@/lib/realtime-source.server"
import { relayInstanceRouteId, type RelayReachability } from "@/lib/relay-fleet"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"
import type { RelayInstance, RelayNode } from "@workspace/contracts"
import type {
  FleetInstance,
  FleetNode,
  RealtimeClientEvent,
} from "@/lib/realtime-events"

const heartbeatIntervalMs = 15_000
const maximumProcessingBacklog = 64
const maximumStreamBufferBytes = 256 * 1024
const sessionValidationIntervalMs = 60_000
const encoder = new TextEncoder()

type RealtimeCursor = Pick<RealtimeSourceEvent, "epoch" | "sequence">

interface RealtimeAccessPolicy {
  isPlatformAdmin: boolean
  readableInstances: Map<string, Set<string>>
  readableRelays: Set<string>
  relayWideRead: Set<string>
  relays: Map<string, PersistedRelay>
}

export async function openAuthorizedRealtimeStream(input: {
  sessionId: string | null
  signal: AbortSignal
  user: AuthenticatedUser
}): Promise<ReadableStream<Uint8Array>> {
  let policy = await loadRealtimeAccessPolicy(input.user)
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let sessionValidation: ReturnType<typeof setInterval> | null = null
  let validatingSession: Promise<void> | null = null
  let queuedEvents = 0
  let pendingRecovery: (RealtimeCursor & { clear: boolean }) | null = null
  let processing = Promise.resolve()
  let unsubscribe: () => void = () => undefined

  const tryEnqueue = (chunk: Uint8Array, force = false): boolean => {
    if (closed || !controller) return false
    const desiredSize = controller.desiredSize
    if (!force && desiredSize !== null && desiredSize < chunk.byteLength) {
      return false
    }
    controller.enqueue(chunk)
    return true
  }
  const flushRecovery = () => {
    if (!pendingRecovery) return
    if (
      tryEnqueue(
        encodeServerEvent({
          clear: pendingRecovery.clear,
          epoch: pendingRecovery.epoch,
          sequence: pendingRecovery.sequence,
          type: "reset",
        }),
        pendingRecovery.clear
      )
    ) {
      pendingRecovery = null
    }
  }
  const enqueueReset = (
    cursor: RealtimeCursor = allocateRealtimeCursor(),
    clear = false
  ) => {
    pendingRecovery =
      pendingRecovery?.epoch === cursor.epoch
        ? {
            clear: pendingRecovery.clear || clear,
            epoch: cursor.epoch,
            sequence: Math.max(pendingRecovery.sequence, cursor.sequence),
          }
        : { ...cursor, clear }
    flushRecovery()
  }
  const enqueue = (event: RealtimeClientEvent) => {
    if (pendingRecovery) {
      enqueueReset(event, pendingRecovery.clear)
      return
    }
    if (!tryEnqueue(encodeServerEvent(event))) {
      enqueueReset(event)
    }
  }

  const processEvent = async (event: RealtimeSourceEvent) => {
    if (event.type === "access.changed") {
      if (!event.userIds.includes(input.user.id)) return
      if (event.reauthenticate) {
        finish(true)
        return
      }
      // Revoke the browser's current view before any fallible policy work. If
      // the database is unavailable, closing the stream prevents later Relay
      // events from being projected through the stale policy; EventSource will
      // reconnect and rebuild it from scratch.
      enqueueReset(event, true)
      try {
        policy = await loadRealtimeAccessPolicy(input.user)
      } catch (cause) {
        console.warn("[Kiln realtime] Could not refresh access policy", cause)
        finish(true)
      }
      return
    }

    if (event.type === "session.revoked") return

    const relay = policy.relays.get(event.relayId)
    if (!relay || !policy.readableRelays.has(relay.id)) return

    if (event.type === "relay.state") {
      enqueue({
        epoch: event.epoch,
        sequence: event.sequence,
        type: "relay.invalidate",
      })
      return
    }
    if (event.type === "relay.snapshot.reset") {
      enqueueReset(event)
      return
    }

    if (event.type === "instance.upsert") {
      if (!canReadInstance(policy, event.relayId, event.instance.id)) return
      enqueue({
        deleted: [],
        epoch: event.epoch,
        sequence: event.sequence,
        type: "instances.delta",
        upserted: [fleetInstance(event.instance, relay)],
      })
      return
    }

    if (event.type === "instance.delete") {
      if (!canReadInstance(policy, event.relayId, event.instanceId)) return
      enqueue({
        deleted: [{ instanceId: event.instanceId, relayId: event.relayId }],
        epoch: event.epoch,
        sequence: event.sequence,
        type: "instances.delta",
        upserted: [],
      })
      return
    }

    const upserted = event.delta.instances.flatMap((instance) =>
      canReadInstance(policy, relay.id, instance.id)
        ? [fleetInstance(instance, relay)]
        : []
    )
    const deleted = event.delta.deletedInstanceIds.flatMap((instanceId) =>
      canReadInstance(policy, relay.id, instanceId)
        ? [{ instanceId, relayId: relay.id }]
        : []
    )
    if (upserted.length > 0 || deleted.length > 0) {
      enqueue({
        deleted,
        epoch: event.epoch,
        sequence: event.sequence,
        type: "instances.delta",
        upserted,
      })
    }
    if (event.delta.node) {
      enqueue({
        epoch: event.epoch,
        nodes: [fleetNode(event.delta.node, relay)],
        sequence: event.sequence,
        type: "nodes.delta",
      })
    }
  }

  unsubscribe = subscribeRealtimeChanges((event) => {
    if (closed) return
    const delivery = classifyRealtimeEvent(event, {
      sessionId: input.sessionId,
      userId: input.user.id,
    })
    if (delivery === "ignore") return
    if (delivery === "close") {
      if (event.type === "access.changed") enqueueReset(event, true)
      finish(true)
      return
    }
    if (delivery === "normal" && queuedEvents >= maximumProcessingBacklog) {
      enqueueReset(event)
      return
    }
    queuedEvents += 1
    processing = processing
      .then(async () => {
        await processEvent(event)
      })
      .catch((cause) => {
        console.error("[Kiln realtime] Could not project event", cause)
        enqueueReset(event)
      })
      .finally(() => {
        queuedEvents -= 1
      })
  })

  function finish(closeController: boolean) {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat) clearInterval(heartbeat)
    if (sessionValidation) clearInterval(sessionValidation)
    input.signal.removeEventListener("abort", abort)
    if (closeController && controller) {
      try {
        controller.close()
      } catch {
        // The consumer may have already cancelled the stream.
      }
    }
    controller = null
  }
  function abort() {
    finish(true)
  }
  input.signal.addEventListener("abort", abort, { once: true })

  const validateSession = () => {
    if (!input.sessionId || closed || validatingSession) return
    validatingSession = runAppEffect(
      "auth.sessions.realtimeValidate",
      accountSessionActiveEffect(input.user.id, input.sessionId)
    )
      .then((active) => {
        if (!active) finish(true)
      })
      .catch((cause) => {
        console.warn("[Kiln realtime] Session validation failed", cause)
        finish(true)
      })
      .finally(() => {
        validatingSession = null
      })
  }
  if (input.sessionId) {
    sessionValidation = setInterval(
      validateSession,
      sessionValidationIntervalMs
    )
  }

  return new ReadableStream<Uint8Array>(
    {
      start(nextController) {
        controller = nextController
        enqueueReset()
        heartbeat = setInterval(() => {
          if (!closed) tryEnqueue(encoder.encode(": heartbeat\n\n"))
        }, heartbeatIntervalMs)
        if (input.signal.aborted) abort()
      },
      pull() {
        flushRecovery()
      },
      cancel() {
        finish(false)
      },
    },
    {
      highWaterMark: maximumStreamBufferBytes,
      size: (chunk) => chunk.byteLength,
    }
  )
}

async function loadRealtimeAccessPolicy(
  user: AuthenticatedUser
): Promise<RealtimeAccessPolicy> {
  const [relays, grants] = await Promise.all([
    listPersistedRelays(),
    isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
  ])
  const visibleRelays = visibleRelaysForUser(user, relays, grants)
  const readableRelays = new Set(visibleRelays.map((relay) => relay.id))
  const relayWideRead = new Set<string>()
  const readableInstances = new Map<string, Set<string>>()
  for (const grant of grants) {
    if (!roleHasPermission(grant.role, "instance.read")) continue
    if (grant.resourceType === "relay") {
      relayWideRead.add(grant.relayId)
      continue
    }
    if (grant.resourceType !== "instance") continue
    let ids = readableInstances.get(grant.relayId)
    if (!ids) {
      ids = new Set()
      readableInstances.set(grant.relayId, ids)
    }
    ids.add(grant.resourceId)
  }
  return {
    isPlatformAdmin: isPlatformAdmin(user),
    readableInstances,
    readableRelays,
    relayWideRead,
    relays: new Map(visibleRelays.map((relay) => [relay.id, relay])),
  }
}

function canReadInstance(
  policy: RealtimeAccessPolicy,
  relayId: string,
  instanceId: string
): boolean {
  if (policy.isPlatformAdmin) return true
  return (
    hasReadableRelayGrant(policy, relayId) ||
    policy.readableInstances.get(relayId)?.has(instanceId) === true
  )
}

function hasReadableRelayGrant(
  policy: RealtimeAccessPolicy,
  relayId: string
): boolean {
  // A Relay is visible to creators without implicitly granting instance read.
  return policy.relayWideRead.has(relayId)
}

function fleetInstance(
  instance: RelayInstance,
  relay: PersistedRelay
): FleetInstance {
  return {
    ...instance,
    relayId: relay.id,
    relayName: relay.name,
    relayStatus: reachability(relay.id),
    routeId: relayInstanceRouteId(relay.id, instance.shortId),
  }
}

function fleetNode(node: RelayNode, relay: PersistedRelay): FleetNode {
  return {
    ...node,
    relayId: relay.id,
    relayName: relay.name,
    relayStatus: reachability(relay.id),
  }
}

function reachability(relayId: string): RelayReachability {
  return relayConnectionState(relayId).status === "authenticated"
    ? "connected"
    : "unreachable"
}

function encodeServerEvent(event: RealtimeClientEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.sequence}\nevent: kiln\ndata: ${JSON.stringify(event)}\n\n`
  )
}
