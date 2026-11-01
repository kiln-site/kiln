import { partKey } from "@/operations/lanes"

/**
 * The lane keys schedules take (docs/hearth-operations.md). Deleting a
 * schedule takes it whole. Saving it takes its `#settings`, which running it
 * now takes shared, so an edit and a run each wait for the other.
 */

/** A schedule: deleting it. */
export const scheduleKey = (id: string) => `schedule:${id}`

/** What it runs: saving it, or shared, running it now. */
export const scheduleSettingsKey = (id: string) =>
  partKey(scheduleKey(id), "settings")
