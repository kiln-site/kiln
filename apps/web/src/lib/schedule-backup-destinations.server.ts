import {
  scheduleActionAppliesToTarget,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import { runAppEffect } from "@/effect/runtime"
import { hasPlatformPermission, type AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hasScheduleTargetPermission } from "@/lib/schedule-permissions"

export async function requireScheduleBackupDestinations(input: {
  checkStorageOwnership?: boolean
  actions: ReadonlyArray<ScheduleAction>
  targets: ReadonlyArray<ScheduleTarget>
  grants: ReadonlyArray<AccessGrant>
  user: AuthenticatedUser
}) {
  const backupActions = input.actions.filter(
    (action): action is Extract<ScheduleAction, { type: "backup" }> =>
      action.type === "backup"
  )
  const storageIds = [
    ...new Set(
      backupActions.flatMap((action) =>
        action.destination.kind === "storage"
          ? [action.destination.storageId]
          : []
      )
    ),
  ]
  await Promise.all(
    storageIds.map(async (storageId) => {
      const storage = await runAppEffect(
        "schedules.loadBackupStorage",
        loadBackupStorageEffect(storageId)
      )
      if (
        !storage ||
        !storage.enabled ||
        storage.deleting ||
        (input.checkStorageOwnership !== false &&
          storage.ownerUserId !== null &&
          storage.ownerUserId !== input.user.id &&
          !hasPlatformPermission(input.user, "platform.backups.manage-storage"))
      ) {
        throw new Error("Backup destination is unavailable")
      }
      if (storage.ownerUserId === null) return
      for (const action of backupActions) {
        if (
          action.destination.kind !== "storage" ||
          action.destination.storageId !== storageId
        )
          continue
        for (const target of input.targets) {
          if (
            scheduleActionAppliesToTarget(action, target) &&
            !hasScheduleTargetPermission({
              grants: input.grants,
              permission: "backup.download",
              target,
              user: input.user,
            })
          ) {
            throw new Error(
              `You do not have backup.download permission for ${target.name}`
            )
          }
        }
      }
    })
  )
}
