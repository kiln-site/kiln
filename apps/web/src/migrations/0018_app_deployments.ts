import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The GitHub repository an app deploys from, and every app's deployments.
// The repository lives outside the app's encrypted config, which holds
// secrets, so a push can find the apps it deploys. Deployments are Hearth's
// record of each one across every Relay; the Relay keeps their logs.
export const appDeployments: Migration = {
  id: 18,
  name: "app_deployments",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const source = databaseTableName("app_github_source")
    const deployment = databaseTableName("app_deployment")
    const appTable = databaseTableName("app")
    const connectionTable = databaseTableName("github_connection")

    // A source removed from Kiln leaves the app's repository, without a
    // connection to read it with.
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${source}\` (
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`connection_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`repository_id\` bigint unsigned NOT NULL,
  \`repository\` varchar(140) NOT NULL,
  \`branch\` varchar(255) NOT NULL,
  \`build\` enum('dockerfile','compose') NOT NULL,
  \`path\` varchar(1024) NOT NULL,
  \`auto_deploy\` tinyint(1) NOT NULL DEFAULT '1',
  \`created_by\` varchar(36) NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`app_id\`),
  KEY \`${source}_repository_idx\` (\`repository_id\`,\`branch\`),
  KEY \`${source}_connection_idx\` (\`connection_id\`),
  CONSTRAINT \`${source}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE,
  CONSTRAINT \`${source}_connection_fk\` FOREIGN KEY (\`connection_id\`) REFERENCES \`${connectionTable}\` (\`id\`) ON DELETE SET NULL
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${deployment}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_deployment_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`source_type\` enum('image','dockerfile','compose','github') NOT NULL,
  \`trigger\` enum('manual','push','poll','redeploy') NOT NULL,
  \`triggered_by\` varchar(36) DEFAULT NULL,
  \`repository\` varchar(140) DEFAULT NULL,
  \`branch\` varchar(255) DEFAULT NULL,
  \`commit_sha\` char(40) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`commit_message\` varchar(255) DEFAULT NULL,
  \`commit_author\` varchar(100) DEFAULT NULL,
  \`status\` enum('running','succeeded','failed','unknown') NOT NULL,
  \`rolling\` tinyint(1) DEFAULT NULL,
  \`error\` varchar(2000) DEFAULT NULL,
  \`started_at\` bigint unsigned NOT NULL,
  \`finished_at\` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`${deployment}_started_idx\` (\`started_at\`),
  KEY \`${deployment}_app_idx\` (\`app_id\`,\`started_at\`),
  KEY \`${deployment}_status_idx\` (\`status\`),
  CONSTRAINT \`${deployment}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE
)`)
  }),
}
