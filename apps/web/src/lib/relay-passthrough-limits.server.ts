import { Transform } from "node:stream"

// Limits on what Hearth carries for Relays it passes transfers through to:
// how many at once, for each Relay and for all of them, how long one may
// stall, and, if set, how fast they go together. Control connections never
// count against them. What's carried is counted for each Relay, so Hearth's
// share is visible on the Relay's page and in metrics.

const PER_RELAY = 8
const SLOT_WAIT_MS = 5_000
const STALL_MS = 60_000

/** Transfers through Hearth at once, for all Relays together. */
export function passthroughCapacity(): number {
  const configured = Number(process.env.KILN_RELAY_PASSTHROUGH_MAX)
  return Number.isInteger(configured) && configured > 0 ? configured : 64
}

// Bytes a second for all transfers through Hearth together, or none.
function passthroughRate(): number | null {
  const configured = Number(process.env.KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND)
  return Number.isFinite(configured) && configured > 0 ? configured : null
}

export interface PassthroughUsage {
  /** Transfers through Hearth to this Relay now. */
  readonly open: number
  /** Bytes carried to and from the Relay since Hearth started. */
  readonly bytesToRelay: number
  readonly bytesFromRelay: number
  /** Transfers turned away because no slot came free in time. */
  readonly refused: number
}

interface Usage {
  open: number
  bytesToRelay: number
  bytesFromRelay: number
  refused: number
}

interface PassthroughState {
  readonly usage: Map<string, Usage>
  readonly waiting: Array<() => void>
  open: number
  // The shared rate's budget, in bytes, as of `refilledAt`.
  budget: number
  refilledAt: number
}

declare global {
  var kilnRelayPassthrough: PassthroughState | undefined
}

const state: PassthroughState = (globalThis.kilnRelayPassthrough ??= {
  budget: 0,
  open: 0,
  refilledAt: Date.now(),
  usage: new Map(),
  waiting: [],
})

function usageOf(relayId: string): Usage {
  let usage = state.usage.get(relayId)
  if (!usage) {
    usage = { bytesFromRelay: 0, bytesToRelay: 0, open: 0, refused: 0 }
    state.usage.set(relayId, usage)
  }
  return usage
}

/** What Hearth has carried for this Relay. */
export function relayPassthroughUsage(relayId: string): PassthroughUsage {
  return { ...usageOf(relayId) }
}

/** What Hearth has carried, for each Relay it carried anything for. */
export function relayPassthroughUsages(): ReadonlyArray<
  PassthroughUsage & { readonly relayId: string }
> {
  return [...state.usage].map(([relayId, usage]) => ({ ...usage, relayId }))
}

export interface PassthroughSlot {
  /** Counts bytes one way, and holds the stall timer off. */
  readonly meter: (direction: "fromRelay" | "toRelay") => Transform
  /** Called when the transfer stalls, to end it. */
  readonly onStall: (end: () => void) => void
  readonly release: () => void
}

/**
 * A slot for one transfer through Hearth to this Relay, waiting briefly for
 * one to come free. Null when none does.
 */
export async function acquirePassthroughSlot(
  relayId: string
): Promise<PassthroughSlot | null> {
  const usage = usageOf(relayId)
  const free = () =>
    usage.open < PER_RELAY && state.open < passthroughCapacity()
  // Taken as soon as it's seen free, so two can't take the last one.
  const take = () => {
    usage.open += 1
    state.open += 1
  }
  if (free()) {
    take()
  } else {
    // Woken whenever a slot comes free, until one is free for it or the
    // wait is up.
    const freed = await new Promise<boolean>((resolve) => {
      const wake = () => {
        if (!free()) return
        take()
        settle(true)
      }
      const timer = setTimeout(() => settle(false), SLOT_WAIT_MS)
      const settle = (got: boolean) => {
        clearTimeout(timer)
        state.waiting.splice(state.waiting.indexOf(wake), 1)
        resolve(got)
      }
      state.waiting.push(wake)
    })
    if (!freed) {
      usage.refused += 1
      return null
    }
  }
  let released = false
  let stalled: () => void = () => undefined
  const stall = setTimeout(() => stalled(), STALL_MS)
  stall.unref()
  return {
    meter: (direction) =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          stall.refresh()
          if (direction === "toRelay") usage.bytesToRelay += chunk.length
          else usage.bytesFromRelay += chunk.length
          const wait = rateDelay(chunk.length)
          if (wait > 0) setTimeout(() => callback(null, chunk), wait)
          else callback(null, chunk)
        },
      }),
    onStall: (end) => {
      stalled = end
    },
    release: () => {
      if (released) return
      released = true
      clearTimeout(stall)
      usage.open -= 1
      state.open -= 1
      // Whoever waits checks again for a slot, in turn; one that takes it
      // leaves the list, so it's read from a copy.
      for (const wake of state.waiting.slice()) wake()
    },
  }
}

// How long to hold `bytes` back to keep to the shared rate, if one is set.
function rateDelay(bytes: number): number {
  const rate = passthroughRate()
  if (rate === null) return 0
  const now = Date.now()
  state.budget = Math.min(
    rate,
    state.budget + ((now - state.refilledAt) / 1000) * rate
  )
  state.refilledAt = now
  state.budget -= bytes
  return state.budget >= 0 ? 0 : Math.ceil((-state.budget / rate) * 1000)
}
