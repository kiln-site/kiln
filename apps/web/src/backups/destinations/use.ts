/**
 * Whether someone may send a target's backups to a destination they chose.
 * One rule for every way a backup is asked for: by hand, in a run, by the
 * CLI, as a copy.
 *
 * - `shared`: a destination the platform keeps, open to anyone who may
 *   back the target up.
 * - `personal`: their own. It hands them what it is sent, so the caller
 *   must also hold `backup.download` on the target.
 * - `platform_only`: their own, but Kiln's own backup goes only where the
 *   platform keeps its own.
 * - `unavailable`: gone, disabled, being deleted, or someone else's. One
 *   answer for all four, so asking says nothing of a destination that
 *   isn't theirs.
 */
export type BackupDestinationUse =
  | "shared"
  | "personal"
  | "platform_only"
  | "unavailable"

export function backupDestinationUse(
  destination: {
    readonly deleting: boolean | number
    readonly enabled: boolean | number
    readonly ownerUserId: string | null
  } | null,
  by: { readonly platformTarget: boolean; readonly userId: string | null }
): BackupDestinationUse {
  if (!destination || !destination.enabled || destination.deleting) {
    return "unavailable"
  }
  if (destination.ownerUserId === null) return "shared"
  if (destination.ownerUserId !== by.userId) return "unavailable"
  return by.platformTarget ? "platform_only" : "personal"
}

/** What to tell someone whose chosen destination can't be used. */
export function backupDestinationRefusal(
  use: "platform_only" | "unavailable"
): string {
  return use === "platform_only"
    ? "Kiln platform backups require platform-owned destinations"
    : "Backup destination is unavailable"
}
