import type { BackupTargetKind } from "@workspace/contracts"

import { backupTargetApp } from "@/lib/backup-target-permissions"
import { hearthKey, resourceKey } from "@/operations/lanes"

/**
 * The lane keys backups and restores take (docs/hearth-operations.md). Each
 * covers Hearth's part of a change, reserving it and handing it to its
 * Relay; the Relay runs it in its own lanes.
 */

/** One backup: changing or restoring from it. */
export const backupKey = (id: string) => `backup:${id}`

/** A backup destination: changing it, or reserving a backup to it. */
export const backupStorageKey = (id: string) => `backup-storage:${id}`

/**
 * What a backup target's data belongs to: its resource, or the App that owns
 * it, whose deletion takes its folder and volumes with it. The platform's is
 * Hearth itself.
 */
export function backupTargetKey(
  relayId: string,
  target: { id: string; kind: BackupTargetKind }
): string {
  if (target.kind === "platform") return hearthKey
  const app = backupTargetApp(target)
  return app
    ? resourceKey("app", relayId, app)
    : resourceKey(
        target.kind as "database" | "instance" | "volume",
        relayId,
        target.id
      )
}
