import { readFile } from "node:fs/promises"

import mysql from "mysql2/promise"

import {
  databaseConnectionConfig,
  databaseTable,
  databaseTableName,
  prefixAppMigrationSql,
} from "./database-config.mjs"

const sql = prefixAppMigrationSql(
  await readFile(new URL("../migrations/app.sql", import.meta.url), "utf8")
)
const connection = await mysql.createConnection({
  ...databaseConnectionConfig(),
  multipleStatements: true,
  timezone: "Z",
})

try {
  await connection.query(sql)
  await ensureFileActivitySchema(connection)
  await ensureInstanceOwnershipSchema(connection)
  await ensureTailscaleNetworkSchema(connection)
  await ensureDatabaseAccessSchema(connection)
  await ensureAccessAssignmentSchema(connection)
  await ensureBackupSchema(connection)
  await ensureScheduleSchema(connection)
  console.log("Kiln application tables are up to date")
} finally {
  await connection.end()
}

async function ensureScheduleSchema(database) {
  const [actionTypeColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("schedule_action")} LIKE 'action_type'`
  )
  const actionType = actionTypeColumns[0]?.Type ?? ""
  if (!actionType.includes("'wait'")) {
    await database.query(
      `ALTER TABLE ${databaseTable("schedule_action")}
       MODIFY action_type ENUM('console_command', 'backup', 'power', 'wait') NOT NULL`
    )
  }
  const [columns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("schedule_run")} LIKE 'status'`
  )
  const statusType = columns[0]?.Type ?? ""
  if (statusType.includes("'running'")) return
  await database.query(
    `ALTER TABLE ${databaseTable("schedule_run")}
     MODIFY status ENUM('running', 'succeeded', 'partial', 'failed', 'noop', 'interrupted', 'missed') NOT NULL`
  )
}

async function ensureBackupSchema(database) {
  const [taskColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_task")}`
  )
  const taskColumnNames = new Set(taskColumns.map((column) => column.Field))
  const progressAdditions = [
    [
      "phase",
      "ENUM('preparing', 'collecting', 'archiving', 'dumping', 'uploading', 'finalizing') NULL AFTER bytes_total",
    ],
    [
      "current_artifact_id",
      "CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER phase",
    ],
    ["current_path", "VARCHAR(2048) NULL AFTER current_artifact_id"],
  ].filter(([name]) => !taskColumnNames.has(name))
  if (progressAdditions.length > 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_task")} ${progressAdditions
        .map(([name, definition]) => `ADD COLUMN ${name} ${definition}`)
        .join(", ")}`
    )
  }
  if (!taskColumnNames.has("reserved_bytes")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_task")}
       ADD COLUMN reserved_bytes BIGINT UNSIGNED NULL AFTER bytes_total`
    )
  }
  if (!taskColumnNames.has("relay_updated_at_ms")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_task")}
       ADD COLUMN relay_updated_at_ms BIGINT UNSIGNED NULL AFTER reserved_bytes`
    )
  }
  const [dependencyColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_task")} LIKE 'depends_on_task_id'`
  )
  if (dependencyColumns.length === 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_task")}
       ADD COLUMN depends_on_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER reserved_bytes,
       ADD KEY ${databaseTable("backup_task_dependency_idx")} (depends_on_task_id)`
    )
  }
  const [privateNetworkColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_storage")} LIKE 'allow_private_network'`
  )
  if (privateNetworkColumns.length === 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_storage")}
       ADD COLUMN allow_private_network BOOLEAN NOT NULL DEFAULT FALSE AFTER force_path_style`
    )
  }
  await database.query(
    `INSERT IGNORE INTO ${databaseTable("backup_artifact")}
      (id, backup_id, destination_key, storage_id, status, filename,
       object_key, bytes, checksum_sha256, completed_at, deleted_at,
       created_at, updated_at)
     SELECT backup.id, backup.id, COALESCE(backup.storage_id, 'local'),
            backup.storage_id, backup.status, backup.filename,
            backup.object_key, backup.bytes, backup.checksum_sha256,
            backup.completed_at, backup.deleted_at,
            backup.created_at, backup.updated_at
       FROM ${databaseTable("backup")} backup`
  )
  await database.query(
    `CREATE TABLE IF NOT EXISTS ${databaseTable("backup_repository")} (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      target_kind ENUM('instance', 'database', 'platform') NOT NULL,
      target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      storage_key VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'local',
      object_prefix VARCHAR(1024) NULL,
      password_ciphertext TEXT NOT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY ${databaseTableName("backup_repository_target_storage_unique")} (relay_id, target_kind, target_id, storage_key)
    )`
  )
  await ensureBackupResticS3Schema(database)
  const [backupColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup")}`
  )
  const backupColumnNames = new Set(backupColumns.map((column) => column.Field))
  if (!backupColumnNames.has("restic_snapshot_id")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup")}
       ADD COLUMN restic_snapshot_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER checksum_sha256`
    )
  }
  if (!backupColumnNames.has("repository_id")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup")}
       ADD COLUMN repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER restic_snapshot_id,
       ADD KEY ${databaseTable("backup_repository_idx")} (repository_id),
       ADD CONSTRAINT ${databaseTable("backup_repository_fk")}
         FOREIGN KEY (repository_id) REFERENCES ${databaseTable("backup_repository")} (id) ON DELETE RESTRICT`
    )
  }
  const artifactKindColumn = backupColumns.find(
    (column) => column.Field === "artifact_kind"
  )
  if (!artifactKindColumn?.Type?.includes("restic_snapshot")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup")}
       MODIFY artifact_kind ENUM('archive', 'database_dump', 'platform_bundle', 'restic_snapshot') NOT NULL`
    )
  }
  const [shareColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_download_share")} LIKE 'artifact_kind'`
  )
  if (!shareColumns[0]?.Type?.includes("restic_snapshot")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_download_share")}
       MODIFY artifact_kind ENUM('archive', 'database_dump', 'platform_bundle', 'restic_snapshot') NOT NULL`
    )
  }
  const taskKindColumn = taskColumns.find(
    (column) => column.Field === "task_kind"
  )
  if (!taskKindColumn?.Type?.includes("export")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_task")}
       MODIFY task_kind ENUM('create', 'restore', 'delete', 'export') NOT NULL`
    )
  }
}

async function ensureBackupResticS3Schema(database) {
  const [storageColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_storage")}`
  )
  const storageColumnNames = new Set(
    storageColumns.map((column) => column.Field)
  )
  if (!storageColumnNames.has("deleting")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_storage")}
       ADD COLUMN deleting BOOLEAN NOT NULL DEFAULT FALSE AFTER enabled`
    )
  }

  const [repositoryColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("backup_repository")}`
  )
  const repositoryColumnNames = new Set(
    repositoryColumns.map((column) => column.Field)
  )
  if (!repositoryColumnNames.has("storage_id")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD COLUMN storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER target_id`
    )
  }
  if (!repositoryColumnNames.has("storage_key")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD COLUMN storage_key VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'local' AFTER storage_id`
    )
  }
  if (!repositoryColumnNames.has("object_prefix")) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD COLUMN object_prefix VARCHAR(1024) NULL AFTER storage_key`
    )
  }
  await database.query(
    `UPDATE ${databaseTable("backup_repository")}
        SET storage_key = IFNULL(storage_id, 'local')
      WHERE storage_key <> IFNULL(storage_id, 'local')`
  )

  const [repositoryIndexes] = await database.query(
    `SHOW INDEX FROM ${databaseTable("backup_repository")}`
  )
  const repositoryIndexNames = new Set(
    repositoryIndexes.map((index) => index.Key_name)
  )
  const storageUnique = databaseTableName(
    "backup_repository_target_storage_unique"
  )
  const legacyUnique = databaseTableName("backup_repository_target_unique")
  if (!repositoryIndexNames.has(storageUnique)) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD UNIQUE KEY ${databaseTable("backup_repository_target_storage_unique")} (relay_id, target_kind, target_id, storage_key)`
    )
  }
  if (repositoryIndexNames.has(legacyUnique)) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       DROP INDEX ${databaseTable("backup_repository_target_unique")}`
    )
  }

  const storageIndex = databaseTableName("backup_repository_storage_idx")
  if (!repositoryIndexNames.has(storageIndex)) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD KEY ${databaseTable("backup_repository_storage_idx")} (storage_id)`
    )
  }

  const [createTableRows] = await database.query(
    `SHOW CREATE TABLE ${databaseTable("backup_repository")}`
  )
  const createTable = createTableRows[0]?.["Create Table"] ?? ""
  const storageFk = databaseTableName("backup_repository_storage_fk")
  if (!createTable.includes(storageFk)) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD CONSTRAINT ${databaseTable("backup_repository_storage_fk")}
         FOREIGN KEY (storage_id) REFERENCES ${databaseTable("backup_storage")} (id) ON DELETE RESTRICT`
    )
  }
  const storageKeyCheck = databaseTableName("backup_repository_storage_key_chk")
  if (!createTable.includes(storageKeyCheck)) {
    await database.query(
      `ALTER TABLE ${databaseTable("backup_repository")}
       ADD CONSTRAINT ${databaseTable("backup_repository_storage_key_chk")}
         CHECK (storage_key = IFNULL(storage_id, 'local'))`
    )
  }
}

async function ensureInstanceOwnershipSchema(database) {
  const [columns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("instance")}`
  )
  const names = new Set(columns.map((column) => column.Field))
  const additions = [
    !names.has("owner_id")
      ? "ADD COLUMN owner_id VARCHAR(36) NULL AFTER display_name"
      : null,
    !names.has("provisioning_reserved_until")
      ? "ADD COLUMN provisioning_reserved_until TIMESTAMP(3) NULL AFTER owner_id"
      : null,
  ].filter(Boolean)
  if (additions.length > 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("instance")} ${additions.join(", ")}`
    )
  }
}

async function ensureDatabaseAccessSchema(database) {
  const [resourceTypeColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("access_grant")} LIKE 'resource_type'`
  )
  if (!resourceTypeColumns[0]?.Type?.includes("'database'")) {
    await database.query(
      `ALTER TABLE ${databaseTable("access_grant")}
       MODIFY resource_type ENUM('relay', 'instance', 'database') NOT NULL`
    )
  }
  const [databaseIdColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("invitation")} LIKE 'database_id'`
  )
  if (databaseIdColumns.length === 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("invitation")}
       ADD COLUMN database_id CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER instance_id`
    )
  }
}

async function ensureAccessAssignmentSchema(database) {
  const [relayCreatorColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("relay")} LIKE 'created_by'`
  )
  if (relayCreatorColumns.length === 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("relay")}
       ADD COLUMN created_by VARCHAR(36) NULL AFTER node_version`
    )
  }

  const [invitationColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("invitation")}`
  )
  const invitationColumnNames = new Set(
    invitationColumns.map((column) => column.Field)
  )
  if (!invitationColumnNames.has("access_type")) {
    await database.query(
      `ALTER TABLE ${databaseTable("invitation")}
       ADD COLUMN access_type ENUM('scoped', 'platform_admin', 'relay_creator')
         NOT NULL DEFAULT 'scoped' AFTER email`
    )
  }
  const relayIdColumn = invitationColumns.find(
    (column) => column.Field === "relay_id"
  )
  const roleColumn = invitationColumns.find((column) => column.Field === "role")
  const invitationChanges = [
    relayIdColumn?.Null === "NO"
      ? "MODIFY relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NULL"
      : null,
    roleColumn?.Null === "NO"
      ? "MODIFY role ENUM('owner', 'admin', 'operator', 'viewer') NULL"
      : null,
  ].filter(Boolean)
  if (invitationChanges.length > 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("invitation")} ${invitationChanges.join(", ")}`
    )
  }
}

async function ensureTailscaleNetworkSchema(database) {
  const [columns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("tailscale_network")}`
  )
  const names = new Set(columns.map((column) => column.Field))
  const additions = [
    [
      "oauth_client_id",
      "VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NULL",
    ],
    ["oauth_client_secret_ciphertext", "TEXT NULL"],
    ["oauth_scopes", "JSON NULL"],
    ["oauth_tags", "JSON NULL"],
    ["oauth_last_synced_at", "TIMESTAMP(3) NULL"],
    ["oauth_last_error", "VARCHAR(512) NULL"],
  ].filter(([name]) => !names.has(name))
  if (additions.length > 0) {
    await database.query(
      `ALTER TABLE ${databaseTable("tailscale_network")} ${additions
        .map(([name, definition]) => `ADD COLUMN ${name} ${definition}`)
        .join(", ")}`
    )
  }
  await ensureTailscaleNetworkDomainUnique(database)
}

async function ensureTailscaleNetworkDomainUnique(database) {
  const tableName = databaseTableName("tailscale_network")
  const [indexes] = await database.execute(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = 'domain'
        AND NON_UNIQUE = 0`,
    [tableName]
  )
  if (indexes.length > 0) return

  const [duplicates] = await database.query(
    `SELECT domain, COUNT(*) AS network_count
       FROM ${databaseTable("tailscale_network")}
      GROUP BY domain
     HAVING COUNT(*) > 1
      LIMIT 1`
  )
  const duplicate = duplicates[0]
  if (duplicate) {
    throw new Error(
      `Cannot make Tailscale network domains unique while ${duplicate.domain} is used by ${duplicate.network_count} networks`
    )
  }

  const constraintName = databaseTableName("tailscale_network_domain_unique")
  await database.query(
    `ALTER TABLE ${databaseTable("tailscale_network")}
     ADD UNIQUE KEY \`${constraintName}\` (domain)`
  )
}

async function ensureFileActivitySchema(database) {
  const [displayNameColumns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable("instance")} LIKE 'display_name'`
  )
  if (
    displayNameColumns[0]?.Null === "NO" ||
    displayNameColumns[0]?.Type?.toLowerCase() !== "varchar(32)"
  ) {
    await database.query(
      `ALTER TABLE ${databaseTable("instance")} MODIFY display_name VARCHAR(32) NULL`
    )
  }
  await database.query(
    `UPDATE ${databaseTable("instance")}
        SET display_name = NULL
      WHERE display_name = ''`
  )

  const activityTableName = databaseTableName("file_activity")
  const instanceConstraintName = databaseTableName("file_activity_instance_fk")
  const relayConstraintName = databaseTableName("file_activity_relay_fk")
  const [constraints] = await database.execute(
    `SELECT CONSTRAINT_NAME
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [activityTableName]
  )
  const constraintNames = new Set(
    constraints.map((constraint) => constraint.CONSTRAINT_NAME)
  )
  if (constraintNames.has(instanceConstraintName)) return

  await database.query(
    `INSERT IGNORE INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name)
     SELECT DISTINCT relay_id, instance_id, NULL
       FROM ${databaseTable("file_activity")}`
  )
  if (constraintNames.has(relayConstraintName)) {
    await database.query(
      `ALTER TABLE ${databaseTable("file_activity")}
       DROP FOREIGN KEY ${databaseTable("file_activity_relay_fk")}`
    )
  }
  await database.query(
    `ALTER TABLE ${databaseTable("file_activity")}
     ADD CONSTRAINT ${databaseTable("file_activity_instance_fk")}
     FOREIGN KEY (relay_id, instance_id)
     REFERENCES ${databaseTable("instance")} (relay_id, instance_id)
     ON DELETE CASCADE`
  )
}
