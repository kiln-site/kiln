import type { BackupTaskInput, RelayBackupTask } from "@workspace/contracts"

type BackupStorage = {
  /** Where the backup's data lives. */
  kind: "local" | "s3"
  /** A restic repository rather than a full archive. */
  restic: boolean
}

/** Where a task reads or writes its backup. */
export function backupTaskStorage(input: BackupTaskInput): BackupStorage {
  switch (input.kind) {
    case "create":
    case "delete":
      return input.destination.kind === "restic"
        ? { kind: input.destination.repository.kind, restic: true }
        : { kind: input.destination.kind, restic: false }
    case "restore":
      if (input.source.kind === "restic") {
        return { kind: input.source.repository.kind, restic: true }
      }
      return {
        kind: input.source.kind === "remote" ? "s3" : "local",
        restic: false,
      }
    case "export":
    case "prune":
      return { kind: input.repository.kind, restic: true }
  }
}

/** Span and log attributes naming a backup task. */
export function backupTaskAttributes(task: RelayBackupTask) {
  const storage = backupTaskStorage(task.input)
  return {
    "backup.id": task.backupId,
    "backup.task.id": task.taskId,
    "backup.task.kind": task.kind,
    "backup.target.kind": task.input.target.kind,
    "backup.storage.kind": storage.kind,
    "backup.storage.restic": storage.restic,
  }
}
