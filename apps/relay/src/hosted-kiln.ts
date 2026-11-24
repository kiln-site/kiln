/**
 * What a Relay saves of a Kiln something else deployed beside it, such as
 * Coolify: what the installation's record holds for one it installed itself,
 * so Kiln's backups carry the same however it was installed. Read from
 * Hearth's container when it proves it runs there, and kept, since Coolify
 * removes the container when it stops Hearth and backups run meanwhile.
 */
import { Effect, Option, Schema } from "effect"

import type { RelayStateStore } from "./effect/state.js"

const HostedKilnSchema = Schema.Struct({
  /** Better Auth's versioned secret list. */
  authSecrets: Schema.String,
  /** The client its Hearth connects as. */
  clientId: Schema.String,
  databaseImage: Schema.String,
  databaseName: Schema.String,
  /** Hearth's DB_TABLE_PREFIX, when it isn't the default. */
  tablePrefix: Schema.NullOr(Schema.String),
  url: Schema.String,
})

export type HostedKiln = typeof HostedKilnSchema.Type

const HostedKilnJson = Schema.fromJsonString(HostedKilnSchema)
const decodeHostedKiln = Schema.decodeUnknownOption(HostedKilnJson)

const metadataKey = (installationId: string) => `hosted_kiln:${installationId}`

export function saveHostedKiln(
  state: RelayStateStore["Service"],
  installationId: string,
  kiln: HostedKiln
) {
  return state.setMetadata(metadataKey(installationId), JSON.stringify(kiln))
}

export const readHostedKiln = Effect.fnUntraced(function* (
  state: Pick<RelayStateStore["Service"], "getMetadata">,
  installationId: string
) {
  const saved = yield* state.getMetadata(metadataKey(installationId))
  return saved ? Option.getOrNull(decodeHostedKiln(saved)) : null
})
