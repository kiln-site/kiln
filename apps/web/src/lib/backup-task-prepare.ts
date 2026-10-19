import { Effect } from "effect"

import type { BackupTaskInput } from "@workspace/contracts"

import {
  invalidBackupDestination,
  prepareFullBackupCreateDestination,
  prepareFullBackupDeleteDestination,
  prepareFullBackupRestoreSource,
  prepareResticRepositoryLocation,
} from "@/backups/destinations"
import {
  loadBackupRepositoryPasswordEffect,
  type BackupDispatch,
} from "@/effect/backups"

export const prepareBackupTaskEffect = Effect.fn("backups.prepareTask")(
  function* (input: BackupDispatch) {
    if (input.kind === "export") {
      const repository = yield* resticRepositoryForBackup(input.backupId)
      const { repositoryPassword: _, ...task } = input
      return {
        ...task,
        repository: repository.location,
        repositoryPassword: repository.password,
      } satisfies BackupTaskInput
    }
    if (input.kind === "create" && input.mode === "incremental") {
      const artifact = input.artifacts[0]
      if (!artifact) {
        return yield* invalidBackupDestination(
          "The backup has no stored artifacts"
        )
      }
      const repository = yield* resticRepositoryForBackup(input.backupId, {
        requireEnabled: true,
      })
      const { artifacts: _, repositoryPassword: __, ...task } = input
      return {
        ...task,
        destination: {
          artifactId: artifact.artifactId,
          kind: "restic" as const,
          repository: repository.location,
          repositoryPassword: repository.password,
        },
        replicas: [],
      } satisfies BackupTaskInput
    }
    if (
      input.kind === "delete" &&
      (input.snapshotId !== undefined || input.createTaskId !== undefined)
    ) {
      const artifact = input.artifacts[0]
      if (!artifact) {
        return yield* invalidBackupDestination(
          "The backup has no stored artifacts"
        )
      }
      const repository = yield* resticRepositoryForBackup(input.backupId)
      const {
        artifacts: _,
        createTaskId,
        repositoryPassword: __,
        snapshotId,
        ...task
      } = input
      return {
        ...task,
        destination: {
          artifactId: artifact.artifactId,
          kind: "restic" as const,
          repository: repository.location,
          repositoryPassword: repository.password,
          ...(snapshotId
            ? { snapshotId }
            : { createTaskId: createTaskId as string }),
        },
        replicas: [],
      } satisfies BackupTaskInput
    }
    if (input.kind === "create" || input.kind === "delete") {
      if (input.artifacts.length === 0) {
        return yield* invalidBackupDestination(
          "The backup has no stored artifacts"
        )
      }
      const destinations: Array<
        Extract<BackupTaskInput, { kind: typeof input.kind }>["destination"]
      > = []
      for (const artifact of input.artifacts) {
        destinations.push(
          input.kind === "create"
            ? yield* prepareFullBackupCreateDestination(artifact)
            : yield* prepareFullBackupDeleteDestination(artifact)
        )
      }
      const [destination, ...replicas] = destinations
      if (!destination) {
        return yield* invalidBackupDestination(
          "The backup has no stored artifacts"
        )
      }
      const { artifacts: _, ...task } = input
      return {
        ...task,
        destination,
        replicas,
      } as BackupTaskInput
    }
    if (input.snapshotId) {
      const repository = yield* resticRepositoryForBackup(input.backupId)
      const {
        artifactId: _,
        objectKey: __,
        repositoryPassword: ___,
        snapshotId,
        storageId: ____,
        ...task
      } = input
      return {
        ...task,
        source: {
          kind: "restic" as const,
          repository: repository.location,
          repositoryPassword: repository.password,
          snapshotId,
        },
      } satisfies BackupTaskInput
    }
    // The archive's size and checksum travel in its source, not the task.
    const {
      artifactId: _,
      bytes: __,
      checksumSha256: ___,
      objectKey: ____,
      storageId: _____,
      ...task
    } = input
    if (input.bytes === undefined || !input.checksumSha256) {
      return yield* invalidBackupDestination(
        "Available backup is missing restore integrity metadata"
      )
    }
    return {
      ...task,
      source: yield* prepareFullBackupRestoreSource({
        artifactId: input.artifactId,
        bytes: input.bytes,
        checksumSha256: input.checksumSha256,
        objectKey: input.objectKey,
        storageId: input.storageId,
      }),
    } satisfies BackupTaskInput
  }
)

const resticRepositoryForBackup = Effect.fnUntraced(function* (
  backupId: string,
  options?: { requireEnabled?: boolean }
) {
  const repository = yield* loadBackupRepositoryPasswordEffect(backupId)
  return {
    location: yield* prepareResticRepositoryLocation({
      objectPrefix: repository.objectPrefix,
      requireEnabled: options?.requireEnabled ?? false,
      storageId: repository.storageId,
    }),
    password: repository.password,
  }
})
