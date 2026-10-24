import { Effect, Option, Schema, Semaphore } from "effect"

import { isKilnInstallationId } from "@workspace/contracts"

import type { ProvenContainer, ProvenHearth, RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"

const INSTALLATION_ID_METADATA_KEY = "installation_id"
const PROVEN_HEARTH_METADATA_KEY = "proven_hearth"

const ProvenContainerSchema = Schema.Struct({
  mounts: Schema.Array(
    Schema.Struct({ destination: Schema.String, source: Schema.String })
  ),
  name: Schema.String,
})

const decodeProvenHearth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      cache: Schema.NullOr(ProvenContainerSchema),
      containerId: Schema.String,
      database: Schema.NullOr(ProvenContainerSchema),
      databaseName: Schema.NullOr(Schema.String),
      installationId: Schema.String,
      secretDigests: Schema.Array(Schema.String),
    })
  )
)

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

/**
 * Loads the saved installation ID unless KILN_INSTALLATION_ID set one, and
 * the Hearth that last proved its container.
 */
export const loadInstallationId = Effect.fn("Relay.installation.load")(
  function* (
    config: InstallationConfig & Pick<RelayConfig, "provenHearth">,
    state: RelayStateStore["Service"]
  ) {
    if (!config.installationIdConfigured) {
      config.installationId = yield* savedInstallationId(state)
    }
    const saved = yield* state.getMetadata(PROVEN_HEARTH_METADATA_KEY)
    config.provenHearth = saved
      ? Option.getOrNull(decodeProvenHearth(saved))
      : null
  }
)

/** Saves a Hearth of this installation that proved its container. */
export const adoptProvenHearth = Effect.fn("Relay.installation.hearth")(
  function* (
    config: Pick<RelayConfig, "installationId" | "provenHearth">,
    state: RelayStateStore["Service"],
    hearth: ProvenHearth
  ) {
    if (hearth.installationId !== config.installationId) return
    const record = provenHearthRecord(hearth)
    if (
      config.provenHearth &&
      provenHearthRecord(config.provenHearth) === record
    ) {
      return
    }
    yield* state.setMetadata(PROVEN_HEARTH_METADATA_KEY, record)
    config.provenHearth = hearth
    yield* Effect.logInfo(`Hearth runs in container ${hearth.containerId}`)
  },
  (effect) => adoption.withPermit(effect)
)

function provenHearthRecord(hearth: ProvenHearth): string {
  const container = (recorded: ProvenContainer | null) =>
    recorded && {
      mounts: recorded.mounts.map(({ destination, source }) => ({
        destination,
        source,
      })),
      name: recorded.name,
    }
  return JSON.stringify({
    cache: container(hearth.cache),
    containerId: hearth.containerId,
    database: container(hearth.database),
    databaseName: hearth.databaseName,
    installationId: hearth.installationId,
    secretDigests: hearth.secretDigests,
  })
}

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
