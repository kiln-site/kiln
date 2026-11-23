import type { ResticRepositoryLocation } from "@workspace/contracts"

import type { RelayConfig } from "../../config.js"
import {
  localBackupDestination,
  localResticDriverLocation,
  localResticGlobalArgs,
  localResticRepositoryString,
} from "./local/index.js"
import { s3BackupDestination } from "./s3/index.js"
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

export function resticDriverLocation(
  config: RelayConfig,
  targetId: string,
  location: ResticRepositoryLocation | undefined
): ResticDriverLocation {
  return !location || location.kind === "local"
    ? localResticDriverLocation(config, targetId, location)
    : location
}

/** Tells one restic repository from another. */
export function resticRepositoryKey(location: ResticDriverLocation): string {
  return location.kind === "local"
    ? localResticRepositoryString(location)
    : `s3:${location.repositoryId}`
}

export function resticGlobalArgs(
  location: ResticDriverLocation
): Array<string> {
  return location.kind === "local" ? localResticGlobalArgs() : []
}
