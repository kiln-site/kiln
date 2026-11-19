import type { Effect } from "effect"

import type {
  BackupArchiveCreateTaskResult,
  BackupCreateTaskInput,
  BackupDeleteTaskInput,
} from "@workspace/contracts"

import type { RelayConfig } from "../../config.js"
import type { BackupStorageAccess } from "../storage-access.js"

export type FullBackupCreateDestination = Exclude<
  BackupCreateTaskInput["destination"],
  { kind: "restic" }
>
export type FullBackupDeleteDestination = Exclude<
  BackupDeleteTaskInput["destination"],
  { kind: "restic" }
>

export type BackupDestinationKind = FullBackupCreateDestination["kind"]

export type ResticLocalDriverLocation = { kind: "local"; path: string }
export type ResticS3DriverLocation = {
  accessKeyId: string
  allowPrivateNetwork: boolean
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  kind: "s3"
  region: string
  repositoryPrefix: string
  secretAccessKey: string
}
export type ResticDriverLocation =
  | ResticLocalDriverLocation
  | ResticS3DriverLocation

export type BackupDestinationDriver<
  TKind extends BackupDestinationKind = BackupDestinationKind,
> = {
  kind: TKind
  maximumFullBackupBytes: number | null
  retainsFullBackupLocally: boolean
  deleteFullBackup: (input: {
    access: BackupStorageAccess
    backupId: string
    config: RelayConfig
    destination: Extract<FullBackupDeleteDestination, { kind: TKind }>
    taskId: string
  }) => Effect.Effect<{ warnings: Array<string> }, unknown>
  saveFullBackup: (input: {
    access: BackupStorageAccess
    backupId: string
    config: RelayConfig
    destination: Extract<FullBackupCreateDestination, { kind: TKind }>
    onChunk: (bytes: number) => void
    result: BackupArchiveCreateTaskResult
    signal: AbortSignal
    taskId: string
  }) => Effect.Effect<BackupArchiveCreateTaskResult, unknown>
}

export function defineBackupDestination<
  const TKind extends BackupDestinationKind,
>(driver: BackupDestinationDriver<TKind>): BackupDestinationDriver<TKind> {
  return driver
}
