import { Effect, Option, Schema } from "effect"

import type { RelayStateStore } from "./effect/state.js"

const METADATA_KEY = "platform_restore"

const RestoreOutcomeSchema = Schema.Struct({
  at: Schema.String,
  backupCreatedAt: Schema.String,
  /** Why it failed, after which what was there before was put back. */
  error: Schema.NullOr(Schema.String),
  /** The platform backup that undoes it, in the Relay's data. */
  undo: Schema.NullOr(Schema.String),
})

/** How this Relay's Kiln was last restored. */
export type RestoreOutcome = typeof RestoreOutcomeSchema.Type

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(RestoreOutcomeSchema)
)

export const readRestoreOutcome = Effect.fnUntraced(function* (
  state: Pick<RelayStateStore["Service"], "getMetadata">
) {
  const saved = yield* state.getMetadata(METADATA_KEY)
  return saved ? Option.getOrNull(decode(saved)) : null
})

/** Never fails what it's about: a whole database isn't given up over this. */
export function saveRestoreOutcome(
  state: Pick<RelayStateStore["Service"], "setMetadata">,
  outcome: RestoreOutcome
) {
  return state
    .setMetadata(METADATA_KEY, JSON.stringify(outcome))
    .pipe(
      Effect.catch((error) =>
        Effect.logError("How Kiln was restored can't be saved", error)
      )
    )
}
