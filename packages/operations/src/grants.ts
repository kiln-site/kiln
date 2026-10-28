import { LockTable, type LaneLock } from "./locks.js"

export interface GrantSelection<W> {
  /** Waiting operations that may start now, in admission order. */
  readonly granted: ReadonlyArray<W>
  /** Ones `admit` turned away; they neither start nor hold anything back. */
  readonly dropped: ReadonlyArray<W>
}

/**
 * The lane rule: picks, in admission order, the waiting operations that may
 * start now. One starts when no granted operation holds a conflicting lock
 * and no operation admitted before it is still waiting on a conflicting
 * one, so conflicting work runs in admission order while work on other
 * resources runs at once. All of an operation's locks are granted together,
 * which rules out deadlock between operations, and a shared operation can't
 * overtake an exclusive one waiting ahead of it.
 *
 * An operation whose locks aren't known yet (`locksOf` returns null) holds
 * back everything after it. `admit`, called once an operation's locks are
 * free, may turn it away, as a precondition that no longer holds does.
 * `blocked` holds keys already spoken for ahead of the line.
 *
 * The locks of granted operations are added to `held`.
 */
export function selectGrants<W>(
  held: LockTable,
  waiting: ReadonlyArray<W>,
  options: {
    readonly admit?: (waiter: W) => boolean
    readonly blocked?: LockTable
    readonly locksOf: (waiter: W) => ReadonlyArray<LaneLock> | null
  }
): GrantSelection<W> {
  const granted: Array<W> = []
  const dropped: Array<W> = []
  const blocked = options.blocked ?? new LockTable()
  for (const waiter of waiting) {
    const locks = options.locksOf(waiter)
    if (locks === null) break
    const free = locks.every(
      (lock) => !held.conflicts(lock) && !blocked.conflicts(lock)
    )
    if (!free) {
      blocked.take(locks)
      continue
    }
    if (options.admit && !options.admit(waiter)) {
      dropped.push(waiter)
      continue
    }
    held.take(locks)
    granted.push(waiter)
  }
  return { dropped, granted }
}

export interface LaneOccupant<Id> {
  readonly id: Id
  readonly locks: ReadonlyArray<LaneLock>
}

export interface WaitReason<Id> {
  /** The operation in the way. */
  readonly id: Id
  /** The key it's in the way on. */
  readonly key: string
  /** Whether it holds the key, or is ahead in line for it. */
  readonly holds: boolean
}

/**
 * What a waiting operation waits on: each granted operation holding a key it
 * conflicts with, and each operation ahead of it in line wanting one.
 */
export function explainWait<Id>(
  locks: ReadonlyArray<LaneLock>,
  holders: Iterable<LaneOccupant<Id>>,
  ahead: Iterable<LaneOccupant<Id>>
): Array<WaitReason<Id>> {
  const reasons: Array<WaitReason<Id>> = []
  const collect = (occupants: Iterable<LaneOccupant<Id>>, holds: boolean) => {
    for (const occupant of occupants) {
      const table = new LockTable()
      table.take(occupant.locks)
      for (const lock of locks) {
        if (table.conflicts(lock)) {
          reasons.push({ holds, id: occupant.id, key: lock.key })
        }
      }
    }
  }
  collect(holders, true)
  collect(ahead, false)
  return reasons
}
