import { Effect, Semaphore } from "effect"

import type { RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"
import { platformSecret, readPlatformState } from "./platform-state.js"

const BACKUP_KEY_METADATA_KEY = "platform_backup_key"

type BackupKeyConfig = Pick<RelayConfig, "dataDirectory" | "platformBackupKey">

// One at a time, so a Hearth proving itself and a backup can't each save a
// key of their own.
const ensuring = Semaphore.makeUnsafe(1)

// The installed Kiln's, or the one saved for a Kiln something else deployed.
const savedPlatformBackupKey = Effect.fnUntraced(function* (
  config: BackupKeyConfig,
  state: RelayStateStore["Service"]
) {
  const installed = yield* readPlatformState(config.dataDirectory)
  return (
    installed?.secrets.platformBackupKey ??
    (yield* state.getMetadata(BACKUP_KEY_METADATA_KEY))
  )
})

/**
 * Loads the saved platform backup key. KILN_PLATFORM_BACKUP_KEY only sets the
 * first one: replacing a saved key would leave every backup made with it,
 * and the recovery code people saved, opening nothing.
 */
export const loadPlatformBackupKey = Effect.fn("Relay.platform.backupKey.load")(
  function* (config: BackupKeyConfig, state: RelayStateStore["Service"]) {
    const saved = yield* savedPlatformBackupKey(config, state)
    if (!saved) return
    if (config.platformBackupKey && config.platformBackupKey !== saved) {
      yield* Effect.logWarning(
        "KILN_PLATFORM_BACKUP_KEY differs from Kiln's saved backup key; keeping the saved key, which opens Kiln's backups"
      )
    }
    config.platformBackupKey = saved
  }
)

/**
 * The platform backup key of the Kiln this Relay runs beside, saved as
 * KILN_PLATFORM_BACKUP_KEY or a generated one when there's none yet.
 */
export const ensurePlatformBackupKey = Effect.fn(
  "Relay.platform.backupKey.ensure"
)(
  function* (config: BackupKeyConfig, state: RelayStateStore["Service"]) {
    const saved = yield* savedPlatformBackupKey(config, state)
    if (saved) {
      config.platformBackupKey = saved
      return
    }
    const key = config.platformBackupKey ?? platformSecret()
    yield* savePlatformBackupKey(state, key)
    config.platformBackupKey = key
    yield* Effect.logInfo("Saved the key Kiln's backups are encrypted with")
  },
  (effect) => ensuring.withPermit(effect)
)

/** Keeps `key` from now on, as after restoring a backup made with it. */
export function savePlatformBackupKey(
  state: RelayStateStore["Service"],
  key: string
) {
  return state.setMetadata(BACKUP_KEY_METADATA_KEY, key)
}
