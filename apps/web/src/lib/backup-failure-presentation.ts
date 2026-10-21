import {
  describeBackupFailure,
  knownBackupFailureCode,
  type BackupFailureDescription,
} from "@workspace/contracts"

import { backupFailedDeleteCopy } from "@/lib/backup-progress-presentation"
import type { BackupRun } from "@/lib/backup-runs"

export type BackupFailure = BackupFailureDescription & {
  /** The Relay's own message, for the details. */
  raw: string
}

type BackupFailureSource = Pick<
  BackupRun,
  "artifacts" | "storageId" | "taskError" | "taskErrorCode"
>

/**
 * Why a backup's latest task failed, explained, or null when it didn't or
 * Kiln can't tell. `providerFor` names the storage provider behind a
 * destination ID, when known.
 */
export function backupTaskFailure(
  backup: BackupFailureSource,
  providerFor: (storageId: string) => string | null
): BackupFailure | null {
  const code = knownBackupFailureCode(backup.taskErrorCode)
  if (!backup.taskError || !code) return null
  // The copy that failed for this reason, else the backup's own storage.
  const storageId =
    backup.artifacts.find(
      (artifact) => artifact.storageId && artifact.errorCode === code
    )?.storageId ?? backup.storageId
  return {
    ...describeBackupFailure(code, storageId ? providerFor(storageId) : null),
    raw: backup.taskError,
  }
}

/** Why one copy of a backup failed, explained, or null. */
export function backupArtifactFailure(
  artifact: BackupRun["artifacts"][number],
  provider: string | null
): BackupFailure | null {
  const code = knownBackupFailureCode(artifact.errorCode)
  if (!artifact.error || !code) return null
  return { ...describeBackupFailure(code, provider), raw: artifact.error }
}

/**
 * Why a backup's latest task failed: its own error, or for a delete that
 * removed some copies, the copy it couldn't. `explained` is set when Kiln
 * knows the cause.
 */
export function backupLatestFailure(
  backup: BackupFailureSource & Pick<BackupRun, "taskKind" | "taskStatus">,
  providerFor: (storageId: string) => string | null
): { explained: BackupFailure | null; message: string } | null {
  const failedCopy = backup.taskError
    ? undefined
    : backupFailedDeleteCopy(backup)
  const message = backup.taskError ?? failedCopy?.error
  if (!message) return null
  return {
    explained: failedCopy
      ? backupArtifactFailure(
          failedCopy,
          failedCopy.storageId ? providerFor(failedCopy.storageId) : null
        )
      : backupTaskFailure(backup, providerFor),
    message,
  }
}
