import { Effect, Semaphore } from "effect"

import { isKilnInstallationId } from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"

const INSTALLATION_ID_METADATA_KEY = "installation_id"

// One adoption at a time, so the saved ID and the one in config can't end up
// from different Hearth sessions.
const adoption = Semaphore.makeUnsafe(1)

type InstallationConfig = Pick<
  RelayConfig,
  "installationId" | "installationIdConfigured"
>

/** The installation ID Hearth gave this Relay, or null before it has. */
export const savedInstallationId = Effect.fnUntraced(function* (
  state: RelayStateStore["Service"]
) {
  const saved = yield* state.getMetadata(INSTALLATION_ID_METADATA_KEY)
  return saved && isKilnInstallationId(saved) ? saved : null
})

/** Loads the saved installation ID unless KILN_INSTALLATION_ID set one. */
export const loadInstallationId = Effect.fn("Relay.installation.load")(
  function* (config: InstallationConfig, state: RelayStateStore["Service"]) {
    if (config.installationIdConfigured) return
    config.installationId = yield* savedInstallationId(state)
  }
)

/**
 * Saves the installation ID a full-access Hearth sent when it connected.
 * Hearth owns the ID, so a different one replaces the saved one; only
 * KILN_INSTALLATION_ID overrides it.
 */
export const adoptInstallationId = Effect.fn("Relay.installation.adopt")(
  function* (
    config: InstallationConfig,
    state: RelayStateStore["Service"],
    installationId: string
  ) {
    if (installationId === config.installationId) return
    if (config.installationIdConfigured) {
      yield* Effect.logWarning(
        `Hearth's installation ID ${installationId} differs from KILN_INSTALLATION_ID; keeping ${config.installationId}`
      )
      return
    }
    if (!isKilnInstallationId(installationId)) {
      yield* Effect.logWarning(
        "Ignoring Hearth's installation ID: it must use 1-120 letters, numbers, dots, underscores, or hyphens"
      )
      return
    }
    yield* state.setMetadata(INSTALLATION_ID_METADATA_KEY, installationId)
    const previous = config.installationId
    config.installationId = installationId
    yield* Effect.logInfo(
      previous
        ? `Hearth changed this Relay's installation ID from ${previous} to ${installationId}`
        : `Saved installation ID ${installationId} from Hearth`
    )
  },
  (effect) => adoption.withPermit(effect)
)
