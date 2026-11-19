import { Effect } from "effect"

import type { ResticRepositoryLocation } from "@workspace/contracts"

import {
  invalidBackupDestination,
  type BackupDestinationTaskDriver,
} from "../types"
import { loadBackupStorageCredentialEffect } from "./storage"

// A task names a bucket's copy and nothing else. The Relay asks Hearth for
// access to it when it's ready to use it (`grantBackupStorageAccessEffect`),
// so a task made now is refused now when its destination can't be used.
export const s3BackupDestinationTaskDriver = {
  kind: "s3",
  prepareFullCreate: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      yield* availableStorage(input.storageId, true)
      return { artifactId: input.artifactId, kind: "s3" as const }
    }),
  prepareFullDelete: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      yield* availableStorage(input.storageId, false)
      return { artifactId: input.artifactId, kind: "s3" as const }
    }),
  prepareFullRestore: (input) =>
    Effect.gen(function* () {
      if (!input.objectKey) {
        return yield* invalidBackupDestination(
          "An S3 backup is missing its remote object key"
        )
      }
      yield* availableStorage(input.storageId, false, true)
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
