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

// A piece waiting its turn at the shared rate.
interface RateWaiter {
  readonly bytes: number
  readonly grant: () => void
}

interface PassthroughState {
  readonly usage: Map<string, Usage>
  readonly waiting: Array<() => void>
  open: number
  // The shared rate's budget, in bytes, as of `refilledAt`, and the pieces
  // waiting on it in turn, which the pacer lets through.
  budget: number
  refilledAt: number
  readonly rateQueue: Array<RateWaiter>
  pacer: ReturnType<typeof setTimeout> | undefined
}

declare global {
  var kilnRelayPassthrough: PassthroughState | undefined
}

const state: PassthroughState = (globalThis.kilnRelayPassthrough ??= {
  budget: 0,
  open: 0,
  pacer: undefined,
  rateQueue: [],
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
  // Pieces of this transfer waiting their turn at the rate, which isn't a
  // stall; a reader that stops reading is.
  let pacing = 0
  const stall = setTimeout(() => {
    if (pacing > 0) stall.refresh()
    else stalled()
  }, STALL_MS)
  stall.unref()
  return {
    meter: (direction) => {
      let cancel: () => void = () => undefined
      return new Transform({
        // Passed on in pieces small enough to share the rate, each counted
        // and charged only as it goes.
        transform(chunk: Buffer, _encoding, callback) {
          let offset = 0
          const next = () => {
            if (offset >= chunk.length) {
              callback()
              return
            }
            const size = Math.min(chunk.length - offset, pieceBytes())
            pacing += 1
            cancel = awaitRate(size, () => {
              pacing -= 1
              cancel = () => undefined
              stall.refresh()
              const piece = chunk.subarray(offset, offset + size)
              offset += size
              if (direction === "toRelay") usage.bytesToRelay += size
              else usage.bytesFromRelay += size
              this.push(piece)
              next()
            })
          }
          next()
        },
        destroy(cause, callback) {
          // A piece still waiting leaves its turn, uncharged.
          cancel()
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

// Calls `grant` once `bytes` may pass at the shared rate, in turn with every
// other piece waiting, and charges them then; at once without a rate.
// Returns what takes the piece out of its turn, uncharged, if it's waiting.
function awaitRate(bytes: number, grant: () => void): () => void {
  if (passthroughRate() === null) {
    grant()
    return () => undefined
  }
  let waiting = true
  const waiter: RateWaiter = {
    bytes,
    grant: () => {
      if (!waiting) return
      waiting = false
      grant()
    },
  }
  state.rateQueue.push(waiter)
  pace()
  return () => {
    if (!waiting) return
    waiting = false
    const index = state.rateQueue.indexOf(waiter)
    if (index === -1) {
      // Granted, but not yet passed on: given back.
      state.budget += bytes
    } else {
      state.rateQueue.splice(index, 1)
    }
    pace()
  }
}

// Lets waiting pieces through, first come first served, as the budget
// allows, and wakes again when the next one fits.
function pace(): void {
  clearTimeout(state.pacer)
  state.pacer = undefined
  const rate = passthroughRate()
  const granted: Array<RateWaiter> = []
  for (let next = state.rateQueue[0]; next; next = state.rateQueue[0]) {
    if (rate === null) {
      granted.push(...state.rateQueue.splice(0))
      break
    }
    const now = Date.now()
    // A clock that steps back refills nothing, rather than taking budget
    // away.
    const elapsed = Math.max(0, now - state.refilledAt)
    state.budget = Math.min(
      Math.max(rate, next.bytes),
      state.budget + (elapsed / 1000) * rate
    )
    state.refilledAt = now
    if (state.budget < next.bytes) {
      state.pacer = setTimeout(
        pace,
        Math.ceil(((next.bytes - state.budget) / rate) * 1000)
      )
      break
    }
    state.budget -= next.bytes
    granted.push(state.rateQueue.shift()!)
  }
  // Granted after the queue settles, since each may ask for its next piece.
  queueMicrotask(() => {
    for (const waiter of granted) waiter.grant()
  })
}
