import type { BackupTargetKind } from "@workspace/contracts"

import { hearthKey, partKey, resourceKey } from "@/operations/lanes"

/**
 * The lane keys backups and restores take (docs/hearth-operations.md). Each
 * covers Hearth's part of a change, reserving it and handing it to its
 * Relay; the Relay runs it in its own lanes.
 */

/** One backup: changing or restoring from it. */
export const backupKey = (id: string) => `backup:${id}`

/** A backup destination: deleting it takes it whole. */
export const backupStorageKey = (id: string) => `backup-storage:${id}`

/**
 * Its settings: saving them takes this exclusive, and reserving a backup to
 * the destination shared, so each waits for the other.
 */
export const backupStorageSettingsKey = (id: string) =>
  partKey(backupStorageKey(id), "settings")

/**
 * What a backup target's data belongs to: its resource. The platform's is
 * Hearth itself.
 */
export function backupTargetKey(
  relayId: string,
  target: { id: string; kind: BackupTargetKind }
): string {
  if (target.kind === "platform") return hearthKey
  return resourceKey(target.kind, relayId, target.id)
}
