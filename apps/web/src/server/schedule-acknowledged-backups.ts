import type { RelayScheduleAction } from "@workspace/contracts/schedules"

/**
 * One backup to a bucket that a Relay holds a schedule for: the
 * destination, and what is backed up there. Kept with the schedule's
 * deployment (`acknowledged_backups`) from the version the Relay last
 * acknowledged, so it says what the Relay was told, not what Hearth means
 * to tell it.
 */
export interface AcknowledgedScheduleBackup {
  readonly storageId: string
  readonly targetId: string
  readonly targetKind: string
}

/**
 * The backups to buckets in what Hearth sent a Relay for one schedule: its
 * full backups that were admitted. One Hearth refused has no destination,
 * and so isn't among them.
 */
export function acknowledgedScheduleBackups(
  actions: ReadonlyArray<RelayScheduleAction>
): Array<AcknowledgedScheduleBackup> {
  return actions.flatMap((action) => {
    if (action.type !== "backup" || action.destination.kind !== "storage") {
      return []
    }
    const storageId = action.destination.storageId
    return action.executions.flatMap((execution) =>
      execution.destination?.kind === "s3"
        ? [
            {
              storageId,
              targetId: execution.targetId,
              // A backup of Kiln itself is a schedule's Relay target.
              targetKind:
                execution.targetKind === "relay"
                  ? "platform"
                  : execution.targetKind,
            },
          ]
        : []
    )
  })
}

/**
 * Whether a deployment's stored record holds a backup of that target to
 * that destination. Kiln's own is one per Relay, whatever it is filed
 * under.
 */
export function holdsScheduleBackup(
  stored: unknown,
  backup: AcknowledgedScheduleBackup
): boolean {
  const held: unknown = typeof stored === "string" ? JSON.parse(stored) : stored
  if (!Array.isArray(held)) return false
  return held.some(
    (entry: Partial<AcknowledgedScheduleBackup> | null) =>
      entry?.storageId === backup.storageId &&
      entry.targetKind === backup.targetKind &&
      (backup.targetKind === "platform" || entry.targetId === backup.targetId)
  )
}
