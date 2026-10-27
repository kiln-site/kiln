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
    meter: (direction) => {
      let paced: ReturnType<typeof setTimeout> | undefined
      return new Transform({
        // Passed on in pieces small enough to keep to the shared rate, each
        // counted and charged only as it goes. Waiting on the rate isn't a
        // stall; a reader that stops reading is.
        transform(chunk: Buffer, _encoding, callback) {
          let offset = 0
          const next = () => {
            paced = undefined
            while (offset < chunk.length) {
              const size = Math.min(chunk.length - offset, pieceBytes())
              const wait = rateWait(size)
              stall.refresh()
              if (wait > 0) {
                paced = setTimeout(next, wait)
                return
              }
              const piece = chunk.subarray(offset, offset + size)
              offset += size
              if (direction === "toRelay") usage.bytesToRelay += size
              else usage.bytesFromRelay += size
              this.push(piece)
            }
            callback()
          }
          next()
        },
        destroy(cause, callback) {
          // What wasn't passed on isn't charged.
          clearTimeout(paced)
          callback(cause)
        },
      })
    },
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

// The most passed on at once: all of it without a rate, else no more than
// a second's worth, and small enough to share the rate between transfers.
function pieceBytes(): number {
  const rate = passthroughRate()
  return rate === null
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.min(16 * 1024, Math.floor(rate)))
}

// How long until `bytes` fit the shared rate, if one is set; 0 when they do
// now, in which case they're charged.
function rateWait(bytes: number): number {
  const rate = passthroughRate()
  if (rate === null) return 0
  const now = Date.now()
  // A clock that steps back refills nothing, rather than taking budget away.
  const elapsed = Math.max(0, now - state.refilledAt)
  state.budget = Math.min(
    Math.max(rate, bytes),
    state.budget + (elapsed / 1000) * rate
  )
  state.refilledAt = now
  if (state.budget >= bytes) {
    state.budget -= bytes
    return 0
  }
  return Math.ceil(((bytes - state.budget) / rate) * 1000)
}
