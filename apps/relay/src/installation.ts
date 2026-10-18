import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"

const INSTALLATION_ID_METADATA_KEY = "installation_id"
// The same rule as KILN_INSTALLATION_ID, since both end up in Docker labels.
const INSTALLATION_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,47}$/u

type InstallationConfig = Pick<
  RelayConfig,
  "installationId" | "installationIdConfigured"
>

/** The installation ID Hearth gave this Relay, or null before it has. */
export const savedInstallationId = Effect.fnUntraced(function* (
  state: RelayStateStore["Service"]
) {
  const saved = yield* state.getMetadata(INSTALLATION_ID_METADATA_KEY)
  return saved && INSTALLATION_ID_PATTERN.test(saved) ? saved : null
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
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      yield* Effect.logWarning(
        "Ignoring Hearth's installation ID: it must be at most 48 lowercase letters, numbers, dots, underscores, or hyphens"
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
  }
)
