import { Effect } from "effect"

import type { ResticRepositoryLocation } from "@workspace/contracts"

import {
  BackupCopyKept,
  invalidBackupDestination,
  type BackupDestinationTaskDriver,
} from "../types"
import { deleteS3BackupObject, s3Failure } from "./client"
import { loadBackupStorageCredentialEffect } from "./storage"

// A task names the copy and nothing in the bucket: no key, path or signed
// request. The Relay asks for access as it is ready to use the copy
// (`grantBackupStorageAccessEffect`), which is when Hearth decides. These
// check only that the task is worth sending.
export const s3BackupDestinationTaskDriver = {
  kind: "s3",
  prepareFullCreate: (input) =>
    Effect.gen(function* () {
      yield* storedCopy(input, true)
      return {
        artifactId: input.artifactId,
        destinationId: input.storageId ?? undefined,
        kind: "s3" as const,
      }
    }),
  prepareFullDelete: (input) =>
    Effect.gen(function* () {
      yield* storedCopy(input, false)
      return {
        artifactId: input.artifactId,
        destinationId: input.storageId ?? undefined,
        kind: "s3" as const,
      }
    }),
  deleteStoredFull: (input) =>
    Effect.gen(function* () {
      const storage = yield* storedCopy(input, false)
      yield* deleteS3BackupObject(storage, input.objectKey ?? "")
    }).pipe(
      Effect.mapError((cause) => {
        const failure = s3Failure(cause)
        return new BackupCopyKept({
          answered: failure?.answered ?? true,
          reason:
            failure?.said ??
            (cause instanceof Error ? cause.message : String(cause)),
        })
      })
    ),
  prepareFullRestore: (input) =>
    Effect.gen(function* () {
      yield* storedCopy(input, false, true)
      return {
        artifactId: input.artifactId,
        bytes: input.bytes,
        checksumSha256: input.checksumSha256,
        kind: "remote" as const,
      }
    }),
  prepareResticRepository: (input) =>
    Effect.gen(function* () {
      if (!input.objectPrefix) {
        return yield* invalidBackupDestination(
          "The restic repository is unavailable"
        )
      }
      const storage = yield* availableStorage(
        input.storageId,
        input.requireEnabled
      )
      return {
        accessKeyId: storage.accessKeyId,
        allowPrivateNetwork: storage.allowPrivateNetwork,
        bucket: storage.bucket,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
        kind: "s3",
        region: storage.region,
        repositoryPrefix: input.objectPrefix,
        secretAccessKey: storage.secretAccessKey,
      } satisfies ResticRepositoryLocation
    }),
} satisfies BackupDestinationTaskDriver<"s3">

const storedCopy = Effect.fnUntraced(function* (
  input: { objectKey: string | null; storageId: string | null },
  requireEnabled: boolean,
  allowDeleting = false
) {
  if (!input.objectKey) {
    return yield* invalidBackupDestination(
      "An S3 backup is missing its remote object key"
    )
  }
  return yield* availableStorage(input.storageId, requireEnabled, allowDeleting)
})

const availableStorage = Effect.fnUntraced(function* (
  storageId: string | null,
  requireEnabled: boolean,
  allowDeleting = false
) {
  if (!storageId) {
    return yield* invalidBackupDestination(
      "The backup destination is unavailable"
    )
  }
  const storage = yield* loadBackupStorageCredentialEffect(storageId)
  if (
    !storage ||
    (!allowDeleting && storage.deleting) ||
    (requireEnabled && !storage.enabled)
  ) {
    return yield* invalidBackupDestination(
      "The backup destination is unavailable"
    )
  }
  return storage
})
