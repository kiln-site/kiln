import { createHash, randomBytes } from "node:crypto"

import { Crypto, Effect, Layer } from "effect"
import {
  ClusterWorkflowEngine,
  RunnerHealth,
  Runners,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/cluster"
import { systemError } from "effect/PlatformError"

import { databaseTablePrefix } from "@/lib/database-config"

/**
 * The prefix of the tables Effect's cluster keeps operations' durable state
 * in: `kiln_ops_messages`, `kiln_ops_replies`, `kiln_ops_runners`, and their
 * migrations. Kept apart from Kiln's own tables, and out of its database
 * export.
 */
export function operationsTablePrefix(): string {
  return `${databaseTablePrefix()}ops`
}

const digests = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
} as const

/** Node's crypto, which the cluster uses to shorten long message keys. */
export const NodeCrypto = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.try({
        try: () =>
          new Uint8Array(createHash(digests[algorithm]).update(data).digest()),
        catch: (cause) =>
          systemError({
            _tag: "Unknown",
            cause,
            description: `Could not hash with ${algorithm}`,
            method: "digest",
            module: "Crypto",
          }),
      }),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
  })
)

/**
 * Hearth's durable workflow engine: Effect's cluster in a single process,
 * its mailboxes and replies in Hearth's MySQL. As `SingleRunner` builds it,
 * but with Kiln's table prefix and a handful of shards: each shard is a MySQL
 * named lock the one runner holds, which also keeps a second Hearth from
 * running the same work.
 */
export const OperationsEngine = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(Sharding.layer),
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.sync(() =>
        SqlMessageStorage.layerWith({ prefix: operationsTablePrefix() })
      )
    )
  ),
  Layer.provide([
    Layer.unwrap(
      Effect.sync(() =>
        Layer.orDie(
          SqlRunnerStorage.layerWith({ prefix: operationsTablePrefix() })
        )
      )
    ),
    RunnerHealth.layerNoop,
  ]),
  Layer.provide(ShardingConfig.layer({ shardsPerGroup: 16 })),
  Layer.provide(NodeCrypto)
)
