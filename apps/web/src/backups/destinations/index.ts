import { Effect } from "effect"

import {
  localBackupDestination,
  localBackupDestinationTaskDriver,
  prepareLocalBackupDownload,
} from "./local"
import {
  prepareS3BackupDownload,
  s3BackupDestination,
  s3BackupDestinationTaskDriver,
} from "./s3"
import type {
  BackupDestinationDefinition,
  BackupDestinationTaskDriver,
  StoredBackupDestination,
} from "./types"
import type { BackupCatalogRecord } from "@/effect/backups"
import type { PersistedRelay } from "@/lib/relay-registry"

export * from "./types"

export const backupDestinations = {
  local: localBackupDestination,
  s3: s3BackupDestination,
} as const satisfies Record<string, BackupDestinationDefinition>

export type BackupDestinationKind = keyof typeof backupDestinations

const backupDestinationTaskDrivers = {
  local: localBackupDestinationTaskDriver,
  s3: s3BackupDestinationTaskDriver,
} as const satisfies {
  [TKind in BackupDestinationKind]: BackupDestinationTaskDriver<TKind>
}

export function backupDestinationFor<TKind extends BackupDestinationKind>(
  kind: TKind
): (typeof backupDestinations)[TKind] {
  return backupDestinations[kind]
}

export function prepareFullBackupCreateDestination(
  input: StoredBackupDestination
) {
  return input.storageId === null
    ? backupDestinationTaskDrivers.local.prepareFullCreate(input)
    : backupDestinationTaskDrivers.s3.prepareFullCreate(input)
}

export function prepareFullBackupDeleteDestination(
  input: StoredBackupDestination
) {
  return input.storageId === null
    ? backupDestinationTaskDrivers.local.prepareFullDelete(input)
    : backupDestinationTaskDrivers.s3.prepareFullDelete(input)
}

export function prepareFullBackupRestoreSource(
  input: StoredBackupDestination & {
    bytes: number
    checksumSha256: string
  }
) {
  return input.storageId === null
    ? backupDestinationTaskDrivers.local.prepareFullRestore(input)
    : backupDestinationTaskDrivers.s3.prepareFullRestore(input)
}

export function prepareResticRepositoryLocation(input: {
  objectPrefix: string | null
  requireEnabled: boolean
  storageId: string | null
}) {
  return Effect.gen(function* () {
    if (input.storageId === null) {
      return yield* backupDestinationTaskDrivers.local.prepareResticRepository(
        input
      )
    }
    return yield* backupDestinationTaskDrivers.s3.prepareResticRepository(input)
  })
}

export function prepareBackupDestinationDownload(input: {
  backup: Pick<BackupCatalogRecord, "id">
  expiresInSeconds: number
  filename: string
  objectKey: string | null
  relay: PersistedRelay | null
  storageId: string | null
  subject: string
}) {
  if (input.storageId === null) {
    if (!input.relay) {
      throw new Error("Backup Relay is unavailable")
    }
    return prepareLocalBackupDownload({ ...input, relay: input.relay })
  }
  return prepareS3BackupDownload({
    expiresInSeconds: input.expiresInSeconds,
    filename: input.filename,
    objectKey: input.objectKey,
    storageId: input.storageId,
  })
}
