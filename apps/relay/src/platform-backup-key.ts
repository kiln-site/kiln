import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"
import { platformSecret, readPlatformState } from "./platform-state.js"

// Each Kiln has its own, so a Relay moved to another Kiln neither hands over
// the one it came from's nor loses it.
const metadataKey = (installationId: string) =>
  `platform_backup_key:${installationId}`

/**
 * The key this Relay's Kiln encrypts its backups with: the one the Relay
 * installed it with, or else the one saved for its installation ID. Null
 * until there is one. Read each time, since a restore saves it from another
 * process.
 */
export const platformBackupKey = Effect.fnUntraced(function* (
  config: Pick<RelayConfig, "dataDirectory" | "installationId">,
  state: RelayStateStore["Service"]
) {
  const { installationId } = config
  if (!installationId) return null
  const installed = yield* readPlatformState(config.dataDirectory)
  if (installed?.installationId === installationId) {
    return installed.secrets.platformBackupKey
  }
  return yield* state.getMetadata(metadataKey(installationId))
})

/**
 * Saves the Kiln's backup key if it has none: KILN_PLATFORM_BACKUP_KEY, or a
 * generated one. A saved key stays, whatever that variable says later:
 * replacing it would leave the backups made with it, and the recovery code
 * people saved, opening nothing.
 */
export const ensurePlatformBackupKey = Effect.fn(
  "Relay.platform.backupKey.ensure"
)(function* (
  config: Pick<
    RelayConfig,
    "dataDirectory" | "installationId" | "platformBackupKey"
  >,
  state: RelayStateStore["Service"]
) {
  const { installationId } = config
  if (!installationId) return
  const configured = config.platformBackupKey
  const saved = yield* platformBackupKey(config, state)
  if (saved) {
    if (configured && configured !== saved) {
      yield* Effect.logWarning(
        "KILN_PLATFORM_BACKUP_KEY differs from Kiln's saved backup key; keeping the saved key, which opens Kiln's backups"
      )
    }
    return
  }
  yield* savePlatformBackupKey(
    state,
    installationId,
    configured ?? platformSecret()
  )
  yield* Effect.logInfo("Saved the key Kiln's backups are encrypted with")
})

/** Makes `key` the one that Kiln's backups use from now on. */
export function savePlatformBackupKey(
  state: RelayStateStore["Service"],
  installationId: string,
  key: string
) {
  return state.setMetadata(metadataKey(installationId), key)
}
