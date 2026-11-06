import { hearthLanes } from "../lanes"

const endedStates = ["cancelled", "failed", "interrupted", "succeeded"]

/**
 * Whether every operation, by its records, has ended and let go of its lanes.
 * A durable operation's row says it ended a moment before its holder wakes and
 * frees them, so what starts on the row alone can be refused by the operation
 * it just waited for.
 */
export const operationsAtRest = (
  records: ReadonlyArray<{ readonly state: string }>
) =>
  records.every((record) => endedStates.includes(record.state)) &&
  hearthLanes.pending.active === 0
