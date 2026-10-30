import { randomUUID } from "node:crypto"

import { Duration, Effect, Layer, Option } from "effect"
import {
  ClusterWorkflowEngine,
  RunnerHealth,
  RunnerAddress,
  Runners,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/cluster"
import { Digest } from "effect/crypto"

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

/**
 * Hearth's durable workflow engine: Effect's cluster in a single process,
 * its mailboxes and replies in Hearth's MySQL. As `SingleRunner` builds it,
 * but with Kiln's table prefix and a handful of shards, each a lock the one
 * runner holds, which also keeps a second Hearth from running the same work.
 *
 * The locks are rows in the cluster's own tables, not MySQL named locks:
 * those are shared by every database on the server, so two Hearths on one
 * MySQL server would hold each other's. Each process is its own runner, so
 * no other can take the locks it holds. A Hearth that stops releases them;
 * one that crashes leaves them to expire, and the next resumes its work then.
 *
 * Each lock write must finish within a third of the expiry; one that doesn't
 * gives up every shard, cutting off running steps. 15 seconds rides out a
 * MySQL busy with other work, as a security sync after a deploy makes it.
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
  Layer.provide(
    ShardingConfig.layer({
      runnerAddress: Option.some(
        RunnerAddress.make(`hearth-${randomUUID()}`, 0)
      ),
      shardLockDisableAdvisory: true,
      shardLockExpiration: Duration.seconds(45),
      shardLockRefreshInterval: Duration.seconds(15),
      shardsPerGroup: 16,
    })
  ),
  // The cluster hashes long message keys with SHA-256 before storing them.
  Layer.provide(Digest.layerWebCrypto)
)
