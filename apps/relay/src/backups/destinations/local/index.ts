import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import { Effect } from "effect"

import type { ResticRepositoryLocation } from "@workspace/contracts"

import type { RelayConfig } from "../../../config.js"
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

export const localBackupDestination = defineBackupDestination({
  deleteFullBackup: ({ backupId, config }) =>
    promiseEffect(() =>
      rm(backupArchivePath(config, backupId), { force: true })
    ).pipe(Effect.as({ warnings: [] })),
  kind: "local",
  maximumFullBackupBytes: null,
  retainsFullBackupLocally: true,
  saveFullBackup: ({ result }) => Effect.succeed(result),
})
