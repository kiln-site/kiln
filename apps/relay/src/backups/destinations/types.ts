import type { Effect } from "effect"

import type {
  BackupArchiveCreateTaskResult,
  BackupCreateTaskInput,
  BackupDeleteTaskInput,
} from "@workspace/contracts"

import type { RelayConfig } from "../../config.js"
import type { ResticRepositoryAccess } from "../restic-bridge.js"
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
/**
 * A repository in a bucket, reached through the bridge with requests
 * Hearth signs (`withResticBridge`). The Relay knows nothing of where in
 * the bucket it is.
 */
export type ResticS3DriverLocation = {
  /** Asks Hearth for one signed request, for the task that runs restic. */
  access: ResticRepositoryAccess
  kind: "s3"
  /** Which repository, to tell one from another on this Relay. */
  repositoryId: string | null
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
    /** Asks Hearth for access to a copy the Relay holds no keys to. */
    access: BackupStorageAccess
    backupId: string
    config: RelayConfig
    destination: Extract<FullBackupDeleteDestination, { kind: TKind }>
  }) => Effect.Effect<{ warnings: Array<string> }, unknown>
  saveFullBackup: (input: {
    access: BackupStorageAccess
    backupId: string
    config: RelayConfig
    destination: Extract<FullBackupCreateDestination, { kind: TKind }>
    onChunk: (bytes: number) => void
    result: BackupArchiveCreateTaskResult
    signal: AbortSignal
  }) => Effect.Effect<BackupArchiveCreateTaskResult, unknown>
}

export function defineBackupDestination<
  const TKind extends BackupDestinationKind,
>(driver: BackupDestinationDriver<TKind>): BackupDestinationDriver<TKind> {
  return driver
}
