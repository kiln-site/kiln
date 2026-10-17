import type { RelayInstance } from "@workspace/contracts"
import { Effect, Option, Schema } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

const Metadata = Schema.Struct({
  brickId: Schema.NullOr(Schema.String),
  game: Schema.String,
  implementation: Schema.String,
  version: Schema.String,
  connectAddress: Schema.String,
  publicHost: Schema.optionalKey(Schema.String),
  publicPort: Schema.optionalKey(Schema.Number),
  tailscaleEnabled: Schema.Boolean,
})
const MetadataJson = Schema.fromJsonString(Metadata)

export type DirectoryInstance = Pick<
  RelayInstance,
  | "id"
  | "name"
  | "brickId"
  | "game"
  | "implementation"
  | "version"
  | "connectAddress"
  | "publicHost"
  | "publicPort"
  | "tailscale"
>

export function instanceDirectoryMetadata(instance: DirectoryInstance) {
  return Schema.encodeSync(MetadataJson)({
    brickId: instance.brickId ?? null,
    game: instance.game,
    implementation: instance.implementation,
    version: instance.version,
    connectAddress: instance.connectAddress,
    ...(instance.publicHost === undefined
      ? {}
      : { publicHost: instance.publicHost }),
    ...(instance.publicPort === undefined
      ? {}
      : { publicPort: instance.publicPort }),
    tailscaleEnabled: instance.tailscale.enabled,
  })
}

interface DirectoryRow extends RowDataPacket {
  relay_id: string
  instance_id: string
  name: string | null
  metadata: string | null
}

const decodeMetadata = Schema.decodeUnknownOption(MetadataJson)

/**
 * Game servers whose metadata a Relay has reported. Reserved placeholders and
 * records from before the directory existed stay hidden until a snapshot
 * fills them in, since nothing identifies their kind yet.
 */
export const listInstanceDirectoryEffect = Effect.fn(
  "instances.directory.list"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<DirectoryRow>(
    "instances.directory.list",
    `SELECT relay_id, instance_id, COALESCE(display_name, source_name) AS name,
            CAST(directory_metadata AS CHAR) AS metadata
       FROM ${databaseTable("instance")}
      WHERE directory_metadata IS NOT NULL
      ORDER BY created_at, instance_id`
  )
  return rows.flatMap((row) => {
    // One unreadable record must not hide every other game server.
    const metadata = Option.getOrUndefined(decodeMetadata(row.metadata))
    if (!metadata) return []
    return [
      {
        id: row.instance_id,
        relayId: row.relay_id,
        name: row.name ?? row.instance_id.slice(0, 8),
        ...metadata,
        brickId: metadata.brickId ?? undefined,
      },
    ]
  })
})
