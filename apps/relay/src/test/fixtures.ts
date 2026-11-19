import type { RestoreArchiveAccess } from "../backup-restore"
import {
  backupRepositoryAccessThrough,
  backupStorageAccessThrough,
  backupTaskOfferThrough,
} from "../backups/storage-access"
import { loadConfig } from "../config"
import type { RelayConfig, RelayInstanceConfig } from "../config"

/**
 * A Relay no Hearth is connected to, as a backup manager finds it: nothing
 * answers when it asks for access to a bucket.
 */
export const noHearth = {
  offer: backupTaskOfferThrough(async () => []),
  repository: backupRepositoryAccessThrough(async () => []),
  storage: backupStorageAccessThrough(async () => []),
}

/** For a restore from the Relay's own disk, which asks for no bucket. */
export const noBucket: RestoreArchiveAccess = () =>
  Promise.reject(new Error("This restore reads no bucket"))

/** A Relay config loaded the same way production loads it, rooted at `dataDirectory`. */
export function testRelayConfig(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = {}
): RelayConfig {
  return loadConfig({
    KILN_RELAY_DATA_DIR: dataDirectory,
    KILN_RELAY_HOST: "relay.test",
    NODE_ENV: "test",
    ...environment,
  })
}

export function testInstance(
  overrides: Partial<RelayInstanceConfig> = {}
): RelayInstanceConfig {
  const id = overrides.id ?? "instance-1"
  return {
    connectAddress: "relay.test",
    directory: id,
    game: "minecraft",
    id,
    implementation: "paper",
    javaVersion: "21",
    limits: { cpuMillis: null, diskBytes: null, memoryBytes: null },
    managedByRelay: true,
    name: "Instance One",
    ports: [],
    service: `kiln-${id}`,
    version: "1.21.8",
    ...overrides,
  }
}
