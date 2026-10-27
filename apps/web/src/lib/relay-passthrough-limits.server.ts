import { Readable } from "node:stream"

import { ensuringPromise, forkPromise } from "@/effect/promise"

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
  /**
   * `source` as passed on one way: counted, kept to the shared rate, and
   * holding the stall timer off while bytes move. It reads `source` only as
   * fast as it's read, and destroying it ends `source`.
   */
  readonly meter: (
    direction: "fromRelay" | "toRelay",
    source: Readable
  ) => Readable
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
  // stall; a reader that stops reading, or a side that stops sending, is.
  let pacing = 0
  const stall = setTimeout(() => {
    if (pacing > 0) stall.refresh()
    else stalled()
  }, STALL_MS)
  stall.unref()
  return {
    meter: (direction, source) => {
      const iterator = source[Symbol.asyncIterator]()
      const ended = new AbortController()
      let pending: Buffer | null = null
      let producing = false
      // Passes on pieces while the reader wants them, each small enough to
      // share the rate, and counted and charged only as it goes.
      const produce = async () => {
        while (!readable.destroyed) {
          if (!pending?.length) {
            // oxlint-disable-next-line react-doctor/async-await-in-loop -- a stream is read in order
            const next = await iterator.next()
            if (readable.destroyed) return
            if (next.done) {
              readable.push(null)
              return
            }
            pending = next.value
            continue
          }
          const size = Math.min(pending.length, pieceBytes())
          pacing += 1
          // oxlint-disable-next-line react-doctor/async-await-in-loop -- pieces pass in order
          await ensuringPromise(
            () => awaitRate(size, ended.signal),
            () => {
              pacing -= 1
            }
          )
          if (readable.destroyed) {
            // Ended after its turn came, before it was passed on.
            refundRate(size)
            return
          }
          stall.refresh()
          const piece = pending.subarray(0, size)
          pending = pending.subarray(size)
          if (direction === "toRelay") usage.bytesToRelay += size
          else usage.bytesFromRelay += size
          // Stops once the reader has enough, until it reads again.
          if (!readable.push(piece)) {
            producing = false
            return
          }
        }
      }
      const readable: Readable = new Readable({
        highWaterMark: 64 * 1024,
        read() {
          if (producing) return
          producing = true
          forkPromise(produce, (cause) => {
            readable.destroy(cause instanceof Error ? cause : undefined)
          })
        },
        destroy(cause, callback) {
          // A piece still waiting leaves its turn, uncharged, and the source
          // ends, even while a read of it is pending.
          ended.abort()
          source.destroy()
          forkPromise(async () => iterator.return?.())
          callback(cause)
        },
      })
      return readable
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

// Resolves once `bytes` may pass at the shared rate, in turn with every
// other piece waiting, charging them then; at once without a rate. Rejects,
// uncharged, if `signal` aborts first.
function awaitRate(bytes: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Transfer ended"))
  if (passthroughRate() === null) {
    // Any still waiting from when there was one go now too.
    if (state.rateQueue.length > 0) pace()
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const waiter: RateWaiter = {
      bytes,
      grant: () => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abandon)
        resolve()
      },
    }
    const abandon = () => {
      if (settled) return
      settled = true
      const index = state.rateQueue.indexOf(waiter)
      if (index === -1) {
        // Granted, but not yet passed on: given back.
        state.budget += bytes
      } else {
        state.rateQueue.splice(index, 1)
      }
      pace()
      reject(new Error("Transfer ended"))
    }
    signal.addEventListener("abort", abandon, { once: true })
    state.rateQueue.push(waiter)
    pace()
  })
}

// Gives back what was charged for bytes that never passed on.
function refundRate(bytes: number): void {
  if (passthroughRate() !== null) state.budget += bytes
}

// How long the pacer waits at most before looking again, so a rate changed
// or removed takes effect for pieces already waiting.
const PACE_RECHECK_MS = 1_000

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
        Math.min(
          PACE_RECHECK_MS,
          Math.ceil(((next.bytes - state.budget) / rate) * 1000)
        )
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
