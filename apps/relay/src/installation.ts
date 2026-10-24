import { Effect, Option, Schema, Semaphore } from "effect"

import { isKilnInstallationId } from "@workspace/contracts"

import type { ProvenContainer, ProvenHearth, RelayConfig } from "./config.js"
import { readPlatformState } from "./platform-state.js"
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
 * Saves the installation ID a full-access Hearth sent when it connected,
 * when the Relay has none yet. One that has an ID keeps it: replacing it
 * takes `relay.installation.replace`, which a person confirms in Hearth, so
 * two Hearths sharing a Relay don't swap it back and forth.
 */
export const adoptInstallationId = Effect.fn("Relay.installation.adopt")(
  function* (
    config: InstallationConfig,
    state: RelayStateStore["Service"],
    installationId: string
  ) {
    if (installationId === config.installationId) return
    if (config.installationId !== null) {
      yield* Effect.logWarning(
        `Hearth's installation ID ${installationId} differs from this Relay's; keeping ${config.installationId}`
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
    config.installationId = installationId
    yield* Effect.logInfo(`Saved installation ID ${installationId} from Hearth`)
  },
  (effect) => adoption.withPermit(effect)
)

/**
 * Whether the Relay's installation ID can't change: KILN_INSTALLATION_ID
 * set it, or Kiln's platform state on this Relay holds it, even when the
 * Relay isn't running in platform mode.
 */
export const installationFixed = Effect.fn("Relay.installation.fixed")(
  function* (
    config: Pick<RelayConfig, "dataDirectory" | "installationIdConfigured">
  ) {
    if (config.installationIdConfigured) return true
    // An unreadable record still counts as one.
    return (
      (yield* readPlatformState(config.dataDirectory).pipe(
        Effect.catch(() => Effect.succeed(true))
      )) !== null
    )
  }
)

/** Why the installation ID wasn't replaced; Hearth reads the code. */
export class InstallationReplaceError extends Schema.TaggedError<InstallationReplaceError>()(
  "InstallationReplaceError",
  {
    code: Schema.Literals(["installation_changed", "installation_fixed"]),
    reason: Schema.String,
  }
) {
  override get message() {
    return this.reason
  }
}

/**
 * Sets the Relay's installation ID to `installationId` while it's still
 * `expectedInstallationId`. Asking again once it's set succeeds, so a lost
 * answer can be retried.
 */
export const replaceInstallationId = Effect.fn("Relay.installation.replace")(
  function* (
    config: InstallationConfig &
      Pick<RelayConfig, "dataDirectory" | "installationIdConfigured">,
    state: RelayStateStore["Service"],
    input: {
      readonly expectedInstallationId: string | null
      readonly installationId: string
    }
  ) {
    if (!isKilnInstallationId(input.installationId)) {
      return yield* new InstallationReplaceError({
        code: "installation_changed",
        reason:
          "Installation IDs use 1-120 letters, numbers, dots, underscores, or hyphens",
      })
    }
    if (config.installationId === input.installationId) {
      return { installationId: input.installationId }
    }
    if (yield* installationFixed(config)) {
      return yield* new InstallationReplaceError({
        code: "installation_fixed",
        reason: `This Relay's installation ID is fixed at ${config.installationId ?? "none"}`,
      })
    }
    if (config.installationId !== input.expectedInstallationId) {
      return yield* new InstallationReplaceError({
        code: "installation_changed",
        reason: `This Relay's installation ID is now ${config.installationId ?? "none"}`,
      })
    }
    yield* state.setMetadata(INSTALLATION_ID_METADATA_KEY, input.installationId)
    const previous = config.installationId
    config.installationId = input.installationId
    yield* Effect.logInfo(
      previous
        ? `Hearth replaced this Relay's installation ID ${previous} with ${input.installationId}`
        : `Saved installation ID ${input.installationId} from Hearth`
    )
    return { installationId: input.installationId }
  },
  (effect) => adoption.withPermit(effect)
)
