/**
 * Lock keys and modes, shared by every home of operation lanes: the Relay's
 * in-memory lanes and Hearth's.
 *
 * An operation names the resources it touches as keys, each shared or
 * exclusive. A whole resource and its parts are separate keys: work on a part
 * takes the whole shared and the part exclusive, and work that replaces the
 * whole takes it exclusive, which waits for every part.
 */

export type LaneMode = "exclusive" | "shared"

export interface LaneLock {
  readonly key: string
  readonly mode: LaneMode
}

export const exclusive = (key: string): LaneLock => ({
  key,
  mode: "exclusive",
})

export const shared = (key: string): LaneLock => ({ key, mode: "shared" })

/**
 * One lock per key, exclusive when any asked for it, in key order, so the
 * same plan always reads, stores, and compares the same way.
 */
export function normalizeLocks(
  locks: ReadonlyArray<LaneLock>
): Array<LaneLock> {
  const modes = new Map<string, LaneMode>()
  for (const lock of locks) {
    if (modes.get(lock.key) !== "exclusive") modes.set(lock.key, lock.mode)
  }
  return [...modes]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, mode]) => ({ key, mode }))
}

interface Held {
  exclusive: boolean
  shared: number
}

/** The locks granted operations hold, by key. */
export class LockTable {
  readonly #held = new Map<string, Held>()

  /** Whether `lock` can't be granted beside what's held. */
  conflicts(lock: LaneLock): boolean {
    const held = this.#held.get(lock.key)
    if (!held) return false
    return held.exclusive || (lock.mode === "exclusive" && held.shared > 0)
  }

  take(locks: ReadonlyArray<LaneLock>): void {
    for (const lock of locks) {
      const held = this.#held.get(lock.key) ?? { exclusive: false, shared: 0 }
      if (lock.mode === "exclusive") held.exclusive = true
      else held.shared += 1
      this.#held.set(lock.key, held)
    }
  }

  release(locks: ReadonlyArray<LaneLock>): void {
    for (const lock of locks) {
      const held = this.#held.get(lock.key)
      if (!held) continue
      if (lock.mode === "exclusive") held.exclusive = false
      else held.shared -= 1
      if (!held.exclusive && held.shared === 0) this.#held.delete(lock.key)
    }
  }
}
