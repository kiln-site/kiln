import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import { Effect } from "effect"

import type { ResticRepositoryLocation } from "@workspace/contracts"

import type { RelayConfig } from "../../../config.js"
import { RelayBackupError } from "../../../effect/errors.js"
import { promiseEffect } from "../../../effect/promise.js"
import { physicalKey } from "../../../instance-keys.js"
import {
  defineBackupDestination,
  type ResticLocalDriverLocation,
} from "../types.js"

export function backupDirectoryPath(config: RelayConfig): string {
  return resolve(config.dataDirectory, "backups")
}

export function backupArchivePath(
  config: RelayConfig,
  backupId: string
): string {
  return resolve(backupDirectoryPath(config), `${backupId}.zip`)
}

export function resticRepositoryPath(
  config: RelayConfig,
  targetId: string
): string {
  // Named after the target's physical key, so one from before 12-character
  // IDs keeps its repository; an App-owned volume's is under its App's.
  return resolve(
    config.dataDirectory,
    "restic",
    "instance",
    targetId.replace(/^[^/]+/u, (owner) => physicalKey(owner))
  )
}

export function localResticDriverLocation(
  config: RelayConfig,
  targetId: string,
  _location?: Extract<ResticRepositoryLocation, { kind: "local" }>
): ResticLocalDriverLocation {
  return { kind: "local", path: resticRepositoryPath(config, targetId) }
}

export function localResticRepositoryString(
  location: ResticLocalDriverLocation
): string {
  return location.path
}

export function localResticGlobalArgs(): Array<string> {
  return ["--no-cache"]
}

// A Relay's own disk is a destination under the Relay's ID. A copy Hearth
// names for another Relay's disk isn't this one's to keep or delete: the
// task was sent to the wrong Relay, or made for one.
function ownDisk(
  config: RelayConfig,
  destination: { readonly destinationId?: string | undefined },
  operation: string
) {
  return destination.destinationId === undefined ||
    destination.destinationId === config.nodeId
    ? Effect.void
    : Effect.fail(
        RelayBackupError.make({
          code: "backup_destination_elsewhere",
          operation,
          reason:
            "The backup's copy is for another Relay's disk, which this Relay holds nothing of",
        })
      )
}

export const localBackupDestination = defineBackupDestination({
  deleteFullBackup: ({ backupId, config, destination }) =>
    ownDisk(config, destination, "delete.local").pipe(
      Effect.andThen(
        promiseEffect(() =>
          rm(backupArchivePath(config, backupId), { force: true })
        )
      ),
      Effect.as({ warnings: [] })
    ),
  kind: "local",
  maximumFullBackupBytes: null,
  retainsFullBackupLocally: true,
  saveFullBackup: ({ config, destination, result }) =>
    ownDisk(config, destination, "create.local").pipe(Effect.as(result)),
})
