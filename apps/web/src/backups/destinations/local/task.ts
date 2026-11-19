import { Effect } from "effect"

import {
  invalidBackupDestination,
  type BackupDestinationTaskDriver,
} from "../types"

export const localBackupDestinationTaskDriver = {
  kind: "local",
  prepareFullCreate: (input) => {
    if (input.storageId !== null || input.objectKey !== null) {
      return invalidBackupDestination(
        "A local backup cannot have a remote object key"
      )
    }
    return Effect.succeed({
      artifactId: input.artifactId,
      destinationId: input.relayId,
      kind: "local",
    })
  },
  prepareFullDelete: (input) => {
    if (input.storageId !== null || input.objectKey !== null) {
      return invalidBackupDestination(
        "A local backup cannot have a remote object key"
      )
    }
    return Effect.succeed({
      artifactId: input.artifactId,
      destinationId: input.relayId,
      kind: "local",
    })
  },
  prepareFullRestore: (input) => {
    if (input.storageId !== null || input.objectKey !== null) {
      return invalidBackupDestination(
        "A local backup cannot have a remote object key"
      )
    }
    return Effect.succeed({
      bytes: input.bytes,
      checksumSha256: input.checksumSha256,
      kind: "local",
    })
  },
  prepareResticRepository: (input) => {
    if (input.storageId !== null) {
      return invalidBackupDestination("The restic repository is unavailable")
    }
    return Effect.succeed({ kind: "local" })
  },
} satisfies BackupDestinationTaskDriver<"local">
