/**
 * Hearth's operation lanes (docs/hearth-operations.md): the same in-memory
 * kernel each Relay runs, one per process, since Hearth runs as one.
 */
import {
  OperationLanes,
  exclusive,
  normalizeLocks,
  shared,
  type LaneLock,
} from "@workspace/operations"
import { Deferred, Effect, Exit } from "effect"

import { publishOperationsChange } from "./realtime"

export { exclusive, shared, type LaneLock }

/** What a run in the lanes is, for refusals and the operator. */
export interface LaneOccupant {
  readonly id: string
  readonly name: string
  readonly doing: string
  readonly durable: boolean
  readonly initiator: Initiator
  readonly actorId: string | null
  readonly admittedAt: number
  startedAt: number | null
}

export type { Initiator } from "./current"
import type { Initiator } from "./current"

// A development reload loads this module again in the same process, whose
// operations still hold their locks; the process keeps one set of lanes.
const state = ((
  globalThis as typeof globalThis & {
    kilnHearthLanes?: {
      readonly lanes: OperationLanes
      readonly occupants: Map<string, LaneOccupant>
      ready: Deferred.Deferred<void>
    }
  }
).kilnHearthLanes ??= {
  lanes: new OperationLanes({
    maxWaiting: 1024,
    messages: { busy: "Hearth is too busy right now. Try again shortly." },
    waitAttribute: "operation.wait_ms",
  }),
  occupants: new Map(),
  // Open unless startup is taking back durable operations' locks.
  ready: (() => {
    const ready = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(ready, Exit.void)
    return ready
  })(),
})

/** The kernel, for the pipeline. Features run operations instead. */
export const hearthLanes = state.lanes

/** Everything in the lanes, by its kernel label. */
export const laneOccupants: ReadonlyMap<string, LaneOccupant> = state.occupants

// The operator's view of the lanes follows them, coalesced. Noted as the
// operation is admitted, in the same step, so nothing comes between.
export const occupy = (label: string, occupant: LaneOccupant): void => {
  state.occupants.set(label, occupant)
  publishOperationsChange()
}

export const vacate = (label: string) =>
  Effect.sync(() => {
    state.occupants.delete(label)
    publishOperationsChange()
  })

/**
 * Holds every admission from now until the returned effect runs, as
 * startup does while it takes back the locks of the durable operations a
 * previous Hearth left running, so nothing slips in ahead of them. Call it
 * before Hearth serves requests.
 */
export function closeLanes(): Effect.Effect<void> {
  const ready = Deferred.makeUnsafe<void>()
  state.ready = ready
  return Effect.sync(() => Deferred.doneUnsafe(ready, Exit.void))
}

/** Waits until the lanes are open. */
export const lanesOpen = Effect.suspend(() => Deferred.await(state.ready))

/**
 * A resource's lane key, such as `instance:<relay>/<id>`. A change to the
 * whole resource, such as deleting it, takes it exclusively.
 */
export const resourceKey = (
  kind: "app" | "database" | "instance" | "volume",
  relayId: string,
  id: string
) => `${kind}:${relayId}/${id}`

/**
 * Who may do what on a game server, database, App, or Relay: its people,
 * invitations and owner.
 */
export const accessKey = (
  kind: "app" | "database" | "instance" | "relay",
  relayId: string,
  id: string
) =>
  kind === "relay"
    ? `relay:${relayId}#access`
    : partKey(resourceKey(kind, relayId, id), "access")

/** A person's account and what they may do. */
export const userKey = (id: string) => `user:${id}`

/**
 * A part of something with a key of its own, such as a game server's DNS
 * (`instance:<relay>/<id>#dns`). Taking a part also takes the whole shared,
 * so taking the whole exclusively waits for, or turns away, every part.
 */
export const partKey = (whole: string, part: string) => `${whole}#${part}`

/** `locks`, with the whole shared for each part, normalized. */
export function withWholes(
  locks: ReadonlyArray<LaneLock>
): ReadonlyArray<LaneLock> {
  return normalizeLocks([
    ...locks,
    ...locks.flatMap((lock) => {
      const at = lock.key.indexOf("#")
      return at < 0 ? [] : [shared(lock.key.slice(0, at))]
    }),
  ])
}

/**
 * The locks of `wanted` that what's already held doesn't cover: one held
 * as strongly, or a part of a whole held exclusively, which nothing else
 * can hold any part of.
 */
export function uncovered(
  wanted: ReadonlyArray<LaneLock>,
  held: ReadonlyArray<LaneLock>
): ReadonlyArray<LaneLock> {
  const modes = new Map(held.map((lock) => [lock.key, lock.mode]))
  return wanted.filter((lock) => {
    const mode = modes.get(lock.key)
    if (mode === "exclusive" || (mode === "shared" && lock.mode === "shared"))
      return false
    const at = lock.key.indexOf("#")
    return !(at >= 0 && modes.get(lock.key.slice(0, at)) === "exclusive")
  })
}
