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
  resticS3EndpointPort,
  s3BackupDestination,
  s3ResticDriverLocation,
  s3ResticGlobalArgs,
  s3ResticRepositoryString,
} from "./s3/index.js"
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
    : s3ResticDriverLocation(location)
}

export function resticRepositoryString(location: ResticDriverLocation): string {
  return location.kind === "local"
    ? localResticRepositoryString(location)
    : s3ResticRepositoryString(location)
}

export function resticGlobalArgs(
  location: ResticDriverLocation
): Array<string> {
  return location.kind === "local"
    ? localResticGlobalArgs()
    : s3ResticGlobalArgs(location)
}

export function applyResticDestinationEnvironment(
  env: NodeJS.ProcessEnv,
  location: ResticDriverLocation,
  options: { cacheDirectory?: string; proxyUrl?: string }
): void {
  if (location.kind === "s3") {
    applyS3ResticEnvironment(env, location, options)
  }
}

export function resticDestinationEndpointPort(
  location: ResticDriverLocation
): number | null {
  return location.kind === "s3" ? resticS3EndpointPort(location.endpoint) : null
}
