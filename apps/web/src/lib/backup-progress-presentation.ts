import {
  type BackupTaskKind,
  type BackupTaskPhase,
  type BackupTaskStatus,
} from "@workspace/contracts"

type BackupUploadPhasePresentation = {
  taskCurrentArtifactId: string | null
  taskPhase: BackupTaskPhase | null
}

type BackupProgressPresentation = BackupUploadPhasePresentation & {
  artifacts: ReadonlyArray<{ storageId: string | null }>
  bytes: number | null
  taskBytesCompleted: number
  taskBytesTotal: number | null
}

type BackupTaskFeedbackPresentation = BackupUploadPhasePresentation & {
  taskError: string | null
  taskKind: BackupTaskKind | null
  taskStatus: BackupTaskStatus | null
}

type BackupDeleteProgressPresentation = {
  artifacts: ReadonlyArray<{
    status:
      | "available"
      | "deleted"
      | "deleting"
      | "failed"
      | "queued"
      | "running"
  }>
  taskCurrentArtifactId: string | null
}

type BackupLocalUploadPresentation = {
  taskKind: BackupTaskKind | null
  taskPhase: BackupTaskPhase | null
  taskStatus: BackupTaskStatus | null
}

export function backupHasReportedDeleteArtifactProgress(
  backup: BackupDeleteProgressPresentation
): boolean {
  return (
    backup.taskCurrentArtifactId !== null ||
    backup.artifacts.some((artifact) => artifact.status === "deleting")
  )
}

export function backupShowsArchivedLocalArtifact(
  backup: BackupLocalUploadPresentation,
  localArtifactWorking: boolean
): boolean {
  return (
    localArtifactWorking &&
    backup.taskKind === "create" &&
    backup.taskStatus === "running" &&
    (backup.taskPhase === "uploading" || backup.taskPhase === "finalizing")
  )
}

export function backupHasPrimaryTaskFeedback(
  backup: BackupTaskFeedbackPresentation
): boolean {
  if (backup.taskKind === null || backup.taskKind === "delete") return false
  if (backup.taskStatus === "queued" || backup.taskStatus === "running") {
    return true
  }
  return (
    Boolean(backup.taskError) &&
    (backup.taskStatus === "failed" || backup.taskStatus === "cancelled")
  )
}

export function backupShowsPrimaryTaskFeedback(
  backup: BackupTaskFeedbackPresentation
): boolean {
  if (!backupHasPrimaryTaskFeedback(backup)) return false
  if (backup.taskStatus !== "queued" && backup.taskStatus !== "running") {
    return true
  }
  return !backupShowsUploadArtifact(backup)
}

export function backupDisplayBytes(
  backup: BackupProgressPresentation
): number | null {
  if (backup.bytes !== null) return backup.bytes
  if (!backupShowsUploadArtifact(backup) || backup.taskBytesTotal === null) {
    return null
  }
  const remoteArtifactCount = backup.artifacts.filter(
    (artifact) => artifact.storageId !== null
  ).length
  if (remoteArtifactCount === 0) return null
  if (remoteArtifactCount > 1 && backup.taskCurrentArtifactId === null) {
    return null
  }
  return backup.taskBytesTotal
}

export function backupTaskUploadProgressPercent(
  backup: BackupProgressPresentation
): number | null {
  if (
    !backupShowsUploadArtifact(backup) ||
    backup.taskBytesTotal === null ||
    backup.taskBytesTotal <= 0
  ) {
    return null
  }
  if (backup.taskPhase === "finalizing") return 100
  return Math.min(
    100,
    Math.floor((backup.taskBytesCompleted / backup.taskBytesTotal) * 100)
  )
}

function backupShowsUploadArtifact(
  backup: BackupUploadPhasePresentation
): boolean {
  return (
    backup.taskPhase === "uploading" ||
    (backup.taskPhase === "finalizing" && backup.taskCurrentArtifactId !== null)
  )
}
