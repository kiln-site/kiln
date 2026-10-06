import type { Effect } from "effect"

import type {
  BackupCreateTaskInput,
  BackupDeleteTaskInput,
  BackupRestoreTaskInput,
  ResticRepositoryLocation,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import { BackupStorageError } from "@/effect/errors"

const FULL_BACKUP_DESTINATION_OPERATIONS = [
  "check",
  "delete",
  "download",
  "read",
  "restore",
  "save",
] as const

const RESTIC_DESTINATION_OPERATIONS = [
  "backup",
  "check",
  "delete",
  "download",
  "prune",
  "restore",
] as const

export type FullBackupDestinationOperation =
  (typeof FULL_BACKUP_DESTINATION_OPERATIONS)[number]
export type ResticDestinationOperation =
  (typeof RESTIC_DESTINATION_OPERATIONS)[number]

type OperationSupport<TOperation extends string> = Readonly<
  Record<TOperation, true>
>

export type FullBackupDestinationStandard =
  OperationSupport<FullBackupDestinationOperation>
export type ResticDestinationStandard =
  OperationSupport<ResticDestinationOperation>

type DestinationFormats =
  | {
      full: FullBackupDestinationStandard
      restic: ResticDestinationStandard | null
    }
  | {
      full: null
      restic: ResticDestinationStandard
    }

export type BackupDestinationDefinition<TKind extends string = string> = {
  kind: TKind
  label: string
  persistence: "configured" | "implicit"
  formats: DestinationFormats
}

export type FullBackupCreateDestination = Exclude<
  BackupCreateTaskInput["destination"],
  { kind: "restic" }
>
export type FullBackupDeleteDestination = Exclude<
  BackupDeleteTaskInput["destination"],
  { kind: "restic" }
>
export type FullBackupRestoreSource = Exclude<
  BackupRestoreTaskInput["source"],
  { kind: "restic" }
>

export type StoredBackupDestination = {
  artifactId: string
  objectKey: string | null
  storageId: string | null
}

export type BackupDestinationTaskDriver<
  TKind extends "local" | "s3" = "local" | "s3",
> = {
  kind: TKind
  prepareFullCreate: (
    input: StoredBackupDestination
  ) => Effect.Effect<
    Extract<FullBackupCreateDestination, { kind: TKind }>,
    unknown,
    Database
  >
  prepareFullDelete: (
    input: StoredBackupDestination
  ) => Effect.Effect<
    Extract<FullBackupDeleteDestination, { kind: TKind }>,
    unknown,
    Database
  >
  prepareFullRestore: (
    input: StoredBackupDestination & {
      bytes: number
      checksumSha256: string
    }
  ) => Effect.Effect<
    TKind extends "local"
      ? Extract<FullBackupRestoreSource, { kind: "local" }>
      : Extract<FullBackupRestoreSource, { kind: "remote" }>,
    unknown,
    Database
  >
  prepareResticRepository: (input: {
    objectPrefix: string | null
    requireEnabled: boolean
    storageId: string | null
  }) => Effect.Effect<ResticRepositoryLocation, unknown, Database>
}

export function defineBackupDestination<
  const TDefinition extends BackupDestinationDefinition,
>(definition: TDefinition): TDefinition {
  return definition
}

export function supportsBackupFormat(
  destination: BackupDestinationDefinition,
  format: "full" | "restic"
): boolean {
  return destination.formats[format] !== null
}

export function invalidBackupDestination(reason: string) {
  return BackupStorageError.make({
    code: "invalid_backup_destination",
    operation: "backup.dispatch",
    reason,
  })
}
