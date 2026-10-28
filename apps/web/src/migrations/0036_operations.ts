import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Hearth's operation lanes (docs/hearth-operations-plan.md). An operation is
// one change from its admission to its end: its place in line (`sequence`),
// the locks it wants or holds, which Hearth drives it (`driver`), and when it
// waited, started, and ended. A durable operation runs as a workflow that
// survives a restart; any other ends with the request that ran it. One
// scheduler row serializes every decision
// to grant or release locks, and hands out places in line.
export const operations: Migration = {
  id: 36,
  name: "operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const lock = databaseTableName("operation_lock")
    const scheduler = databaseTableName("operation_scheduler")
    const driver = databaseTableName("operation_driver")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${operation}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`kind\` varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`version\` smallint unsigned NOT NULL,
  \`durable\` tinyint(1) NOT NULL DEFAULT '0',
  \`sequence\` bigint unsigned NOT NULL,
  \`idempotency_key\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`input_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`input\` json DEFAULT NULL,
  \`state\` enum('waiting','granted','running','succeeded','failed','cancelled','interrupted') NOT NULL,
  \`actor_id\` varchar(36) DEFAULT NULL,
  \`driver\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`execution_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`trace_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`span_id\` char(16) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`trace_sampled\` tinyint(1) NOT NULL DEFAULT '0',
  \`error\` varchar(1024) DEFAULT NULL,
  \`admitted_at\` bigint unsigned NOT NULL,
  \`granted_at\` bigint unsigned DEFAULT NULL,
  \`started_at\` bigint unsigned DEFAULT NULL,
  \`finished_at\` bigint unsigned DEFAULT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${operation}_sequence_unique\` (\`sequence\`),
  UNIQUE KEY \`${operation}_idempotency_unique\` (\`kind\`,\`idempotency_key\`),
  KEY \`${operation}_state_idx\` (\`state\`,\`sequence\`),
  KEY \`${operation}_finished_idx\` (\`finished_at\`)
)`)
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${lock}\` (
  \`operation_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`lock_key\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`mode\` enum('shared','exclusive') NOT NULL,
  \`held\` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (\`operation_id\`,\`lock_key\`),
  KEY \`${lock}_key_idx\` (\`lock_key\`,\`held\`),
  CONSTRAINT \`${lock}_operation_fk\` FOREIGN KEY (\`operation_id\`) REFERENCES \`${operation}\` (\`id\`) ON DELETE CASCADE
)`)
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${scheduler}\` (
  \`id\` tinyint unsigned NOT NULL,
  \`next_sequence\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`)
)`)
    yield* sql.unsafe(
      `INSERT IGNORE INTO \`${scheduler}\` (id, next_sequence) VALUES (1, 1)`
    )
    // Each running Hearth's heartbeat: work is taken from one only once its
    // heartbeat has stopped.
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${driver}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`started_at\` bigint unsigned NOT NULL,
  \`heartbeat_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`)
)`)
  }),
}
