import type { ResticRepositoryLocation } from "@workspace/contracts"

import type { RelayConfig } from "../../config.js"
import {
  localBackupDestination,
  localResticDriverLocation,
  localResticGlobalArgs,
  localResticRepositoryString,
} from "./local/index.js"
import {
  applyS3ResticEnvironment,
  s3BackupDestination,
  s3ResticDriverLocation,
} from "./s3/index.js"
import type { ResticRepositoryAccess } from "../restic-bridge.js"
import type {
  BackupDestinationDriver,
  BackupDestinationKind,
  ResticDriverLocation,
} from "./types.js"

export {
  backupArchivePath,
  backupDirectoryPath,
  resticRepositoryPath,
} from "./local/index.js"
export type {
  BackupDestinationDriver,
  BackupDestinationKind,
  ResticDriverLocation,
} from "./types.js"

const backupDestinations = {
  local: localBackupDestination,
  s3: s3BackupDestination,
} as const satisfies {
  [TKind in BackupDestinationKind]: BackupDestinationDriver<TKind>
}

export function backupDestinationFor<TKind extends BackupDestinationKind>(
  kind: TKind
): (typeof backupDestinations)[TKind] {
  return backupDestinations[kind]
}

/**
 * Where a repository is, for restic. One in a bucket is reached with
 * requests Hearth signs, which `access` asks for on the task's behalf.
 */
export function resticDriverLocation(
  config: RelayConfig,
  targetId: string,
  location: ResticRepositoryLocation | undefined,
  access: ResticRepositoryAccess
): ResticDriverLocation {
  return !location || location.kind === "local"
    ? localResticDriverLocation(config, targetId, location)
    : s3ResticDriverLocation(location, access)
}

/**
 * A name for the repository that is the same every time, to tell one
 * from another on this Relay.
 */
export function resticRepositoryKey(
  location: ResticDriverLocation,
  targetId: string
): string {
  return location.kind === "local"
    ? localResticRepositoryString(location)
    : `bucket:${location.repositoryId ?? targetId}`
}

export function resticGlobalArgs(
  location: ResticDriverLocation
): Array<string> {
  return location.kind === "local" ? localResticGlobalArgs() : []
}

/** What restic is told of a repository on the Relay's own disk. */
export function localRepositoryString(location: ResticDriverLocation): string {
  if (location.kind !== "local") {
    throw new Error("A repository in a bucket is reached through the bridge")
  }
  return localResticRepositoryString(location)
}

export function applyResticDestinationEnvironment(
  env: NodeJS.ProcessEnv,
  location: ResticDriverLocation,
  options: { cacheDirectory?: string }
): void {
  if (location.kind === "s3") applyS3ResticEnvironment(env, options)
}
