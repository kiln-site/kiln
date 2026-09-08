import { randomUUID } from "node:crypto"
import { databaseTable } from "./database-config.mjs"
import { legacyAccessPermissions } from "./legacy-access-permissions.mjs"

export const userAdditions = {
  status: "VARCHAR(16) NOT NULL DEFAULT 'enabled'",
  statusChangedAt: "TIMESTAMP(3) NULL",
  statusChangedBy: "VARCHAR(36) NULL",
  statusReason: "TEXT NULL",
  statusExpiresAt: "TIMESTAMP(3) NULL",
  emailVerifiedAt: "TIMESTAMP(3) NULL",
  manuallyVerifiedAt: "TIMESTAMP(3) NULL",
  manuallyVerifiedBy: "VARCHAR(36) NULL",
  legacyVerificationRecordedAt: "TIMESTAMP(3) NULL",
}
export const grantAdditions = {
  state: "ENUM('pending', 'active', 'revoked') NOT NULL DEFAULT 'active'",
  revision: "BIGINT UNSIGNED NOT NULL DEFAULT 1",
}
export const invitationAdditions = {
  access_id: "CHAR(36) NULL",
  user_id: "VARCHAR(36) NULL",
  accepted_by: "VARCHAR(36) NULL",
  acceptance_method: "ENUM('self', 'admin', 'legacy') NULL",
  declined_at: "TIMESTAMP(3) NULL",
  cancelled_at: "TIMESTAMP(3) NULL",
  cancelled_by: "VARCHAR(36) NULL",
  delivery_status:
    "ENUM('pending', 'sent', 'failed', 'not_required', 'legacy') NOT NULL DEFAULT 'pending'",
  delivery_attempts: "INT UNSIGNED NOT NULL DEFAULT 0",
  delivery_last_error: "VARCHAR(512) NULL",
  delivery_next_attempt_at: "TIMESTAMP(3) NULL",
  sent_at: "TIMESTAMP(3) NULL",
}

async function addColumns(database, table, additions) {
  const [columns] = await database.query(
    `SHOW COLUMNS FROM ${databaseTable(table)}`
  )
  const existing = new Set(columns.map((column) => column.Field))
  const changes = Object.entries(additions).filter(
    ([name]) => !existing.has(name)
  )
  if (changes.length)
    await database.query(
      `ALTER TABLE ${databaseTable(table)} ${changes.map(([name, definition]) => `ADD COLUMN \`${name}\` ${definition}`).join(", ")}`
    )
}

export async function ensureAccessModelSchema(database) {
  await addColumns(database, "user", userAdditions)
  await addColumns(database, "access_grant", grantAdditions)
  await addColumns(database, "invitation", invitationAdditions)
  for (const [table, index, columns] of [
    ["invitation", "invitation_access_expiry_idx", "access_id, expires_at"],
    ["instance", "instance_owner_scope_idx", "owner_id, relay_id, instance_id"],
    [
      "database",
      "database_owner_scope_idx",
      "created_by, relay_id, database_id",
    ],
    [
      "access_grant",
      "access_grant_scope_state_idx",
      "relay_id, resource_type, resource_id, state, user_id",
    ],
    ["access_grant", "access_grant_user_state_idx", "user_id, state, relay_id"],
    [
      "invitation",
      "invitation_user_access_idx",
      "user_id, access_id, expires_at",
    ],
    [
      "invitation",
      "invitation_delivery_idx",
      "delivery_status, delivery_next_attempt_at",
    ],
  ]) {
    const [indexes] = await database.query(
      `SHOW INDEX FROM ${databaseTable(table)}`
    )
    if (
      !indexes.some((row) => `\`${row.Key_name}\`` === databaseTable(index))
    ) {
      await database.query(
        `ALTER TABLE ${databaseTable(table)} ADD KEY ${databaseTable(index)} (${columns})`
      )
    }
  }
}

// DDL runs separately: MySQL implicitly commits it. The data conversion and marker
// commit together, so interruption/retry cannot resurrect later access edits.
export async function backfillAccessModel(database) {
  await database.beginTransaction()
  try {
    await database.execute(
      `INSERT IGNORE INTO ${databaseTable("data_migration")} (id) VALUES (?)`,
      ["access-permissions-v1"]
    )
    const [marker] = await database.execute(
      `SELECT completed_at FROM ${databaseTable("data_migration")} WHERE id = ? FOR UPDATE`,
      ["access-permissions-v1"]
    )
    if (marker[0].completed_at) {
      await database.commit()
      return { alreadyApplied: true }
    }
    const [collisions] = await database.query(
      `SELECT COUNT(*) AS count FROM (SELECT LOWER(TRIM(email)) FROM ${databaseTable("user")} GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1) collisions`
    )
    if (Number(collisions[0].count))
      throw new Error(
        "Access migration requires resolving normalized user email collisions before upgrading"
      )
    const [emailColumns] = await database.query(
      `SHOW FULL COLUMNS FROM ${databaseTable("user")} LIKE 'email'`
    )
    const emailWidth = /^varchar\((\d+)\)$/iu.exec(
      emailColumns[0]?.Type ?? ""
    )?.[1]
    if (!emailWidth)
      throw new Error(
        "Access migration requires a VARCHAR identity email column; review the existing identity schema before upgrading"
      )
    const [oversized] = await database.execute(
      `SELECT COUNT(*) AS count FROM ${databaseTable("invitation")} WHERE CHAR_LENGTH(TRIM(email)) > ? OR TRIM(email) = ''`,
      [Number(emailWidth)]
    )
    if (Number(oversized[0].count))
      throw new Error(
        "Access migration found invitation emails incompatible with the identity email column; resolve before upgrading"
      )
    await database.query(
      `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) SELECT id, 'account.legacy-migration', JSON_OBJECT('legacyEmail', email, 'banned', banned, 'banExpires', banExpires, 'banReason', banReason, 'verification', IF(emailVerified, 'legacy', 'unverified')) FROM ${databaseTable("user")}`
    )
    await database.query(`UPDATE ${databaseTable("user")} SET
      email = LOWER(TRIM(email)),
      legacyVerificationRecordedAt = CASE WHEN emailVerified = TRUE AND emailVerifiedAt IS NULL AND manuallyVerifiedAt IS NULL THEN CURRENT_TIMESTAMP(3) ELSE legacyVerificationRecordedAt END,
      status = CASE WHEN banned = TRUE AND (banExpires IS NULL OR banExpires > CURRENT_TIMESTAMP(3)) THEN 'disabled' ELSE status END,
      statusChangedAt = COALESCE(statusChangedAt, CURRENT_TIMESTAMP(3)),
      statusReason = CASE WHEN banned = TRUE THEN banReason ELSE statusReason END,
      statusExpiresAt = CASE WHEN banned = TRUE AND banExpires > CURRENT_TIMESTAMP(3) THEN banExpires ELSE statusExpiresAt END,
      banned = FALSE, banReason = NULL, banExpires = NULL`)
    // Reserve identities without credentials. Existing users keep all identity and
    // verification fields; invitations bind once to IDs, never to future email edits.
    const [invitations] = await database.query(
      `SELECT * FROM ${databaseTable("invitation")} ORDER BY created_at, id`
    )
    for (const invitation of invitations) {
      const email = invitation.email.trim().toLowerCase()
      let [users] = await database.execute(
        `SELECT id FROM ${databaseTable("user")} WHERE LOWER(TRIM(email)) = ?`,
        [email]
      )
      if (!users.length) {
        const userId = randomUUID()
        await database.execute(
          `INSERT INTO ${databaseTable("user")} (id, name, email, emailVerified, createdAt, updatedAt, status, statusChangedAt, role) VALUES (?, ?, ?, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 'enabled', CURRENT_TIMESTAMP(3), 'user')`,
          [userId, email.split("@")[0], email]
        )
        users = [{ id: userId }]
      }
      const userId = users[0].id
      let accessId = null
      if (invitation.access_type === "scoped" && invitation.relay_id) {
        const scope = invitation.database_id
          ? "database"
          : invitation.instance_id
            ? "instance"
            : "relay"
        const resourceId =
          invitation.database_id ??
          invitation.instance_id ??
          invitation.relay_id
        let [grants] = await database.execute(
          `SELECT id FROM ${databaseTable("access_grant")} WHERE user_id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ?`,
          [userId, invitation.relay_id, scope, resourceId]
        )
        if (!grants.length && !invitation.accepted_at) {
          accessId = randomUUID()
          await database.execute(
            `INSERT INTO ${databaseTable("access_grant")} (id,user_id,relay_id,resource_type,resource_id,role,granted_by,state) VALUES (?,?,?,?,?,?,?,'pending')`,
            [
              accessId,
              userId,
              invitation.relay_id,
              scope,
              resourceId,
              invitation.role ?? "viewer",
              invitation.invited_by,
            ]
          )
          grants = [{ id: accessId }]
        }
        accessId = grants[0]?.id ?? null
        if (accessId && !invitation.accepted_at && !invitation.revoked_at) {
          await database.execute(
            `UPDATE ${databaseTable("access_grant")} SET role = ?, granted_by = ? WHERE id = ? AND state = 'pending'`,
            [invitation.role ?? "viewer", invitation.invited_by, accessId]
          )
        }
      }
      await database.execute(
        `UPDATE ${databaseTable("invitation")} SET user_id = ?, access_id = ?, acceptance_method = CASE WHEN accepted_at IS NOT NULL THEN 'legacy' ELSE NULL END, cancelled_at = CASE WHEN accepted_at IS NULL THEN revoked_at ELSE NULL END, delivery_status = 'legacy' WHERE id = ?`,
        [userId, accessId, invitation.id]
      )
    }
    const [grants] = await database.query(
      `SELECT g.id, g.role, g.resource_type, d.engine FROM ${databaseTable("access_grant")} g LEFT JOIN ${databaseTable("database")} d ON g.resource_type = 'database' AND d.database_id = g.resource_id AND d.relay_id = g.relay_id`
    )
    for (const grant of grants) {
      for (const permission of legacyAccessPermissions(
        grant.role,
        grant.resource_type,
        grant.engine
      )) {
        await database.execute(
          `INSERT IGNORE INTO ${databaseTable("access_selection")} (access_id, selection_kind, selection_key) VALUES (?, 'permission', ?)`,
          [grant.id, permission]
        )
      }
    }
    await database.query(`UPDATE ${databaseTable("instance")} target JOIN
      (SELECT relay_id, resource_id, MIN(user_id) AS user_id FROM ${databaseTable("access_grant")} WHERE resource_type = 'instance' AND role = 'owner' AND state = 'active' GROUP BY relay_id, resource_id HAVING COUNT(*) = 1) owners
      ON target.relay_id = owners.relay_id AND target.instance_id = owners.resource_id
      SET target.owner_id = owners.user_id WHERE target.owner_id IS NULL`)
    const [ownerAnomalies] = await database.query(
      `SELECT COUNT(*) AS count FROM ${databaseTable("instance")} target WHERE target.owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${databaseTable("user")} subject WHERE subject.id = target.owner_id) OR EXISTS (SELECT 1 FROM ${databaseTable("access_grant")} grant_row WHERE grant_row.relay_id = target.relay_id AND grant_row.resource_type = 'instance' AND grant_row.resource_id = target.instance_id AND grant_row.role = 'owner' AND grant_row.state = 'active' AND grant_row.user_id <> target.owner_id)`
    )
    const ownershipByResource = { instance: Number(ownerAnomalies[0].count) }
    for (const [table, idColumn] of [
      ["relay", "id"],
      ["database", "database_id"],
    ]) {
      const [anomalies] = await database.query(
        `SELECT COUNT(*) AS count FROM ${databaseTable(table)} target WHERE target.created_by IS NULL OR NOT EXISTS (SELECT 1 FROM ${databaseTable("user")} subject WHERE subject.id = target.created_by) OR EXISTS (SELECT 1 FROM ${databaseTable("access_grant")} grant_row WHERE grant_row.resource_type = '${table}' AND grant_row.resource_id = target.${idColumn} AND grant_row.role = 'owner' AND grant_row.state = 'active' AND grant_row.user_id <> target.created_by)`
      )
      ownershipByResource[table] = Number(anomalies[0].count)
    }
    await database.execute(
      `UPDATE ${databaseTable("data_migration")} SET completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      ["access-permissions-v1"]
    )
    await database.commit()
    return {
      alreadyApplied: false,
      grants: grants.length,
      invitations: invitations.length,
      ownershipAnomalies: Object.values(ownershipByResource).reduce(
        (total, count) => total + count,
        0
      ),
      ownershipByResource,
    }
  } catch (error) {
    await database.rollback()
    throw error
  }
}

// Correct only impossible direct selections from earlier access-model snapshots.
// The marker prevents later administrator edits being rewritten on every startup.
export async function projectLegacyDatabasePermissions(database) {
  await database.beginTransaction()
  try {
    const migration = "access-permissions-engine-projection-v1"
    await database.execute(
      `INSERT IGNORE INTO ${databaseTable("data_migration")} (id) VALUES (?)`,
      [migration]
    )
    const [marker] = await database.execute(
      `SELECT completed_at FROM ${databaseTable("data_migration")} WHERE id = ? FOR UPDATE`,
      [migration]
    )
    if (marker[0].completed_at) {
      await database.commit()
      return { alreadyApplied: true }
    }
    const [result] = await database.query(
      `DELETE s FROM ${databaseTable("access_selection")} s JOIN ${databaseTable("access_grant")} g ON g.id = s.access_id JOIN ${databaseTable("database")} d ON d.database_id = g.resource_id AND d.relay_id = g.relay_id WHERE g.resource_type = 'database' AND d.engine IN ('redis', 'valkey') AND s.selection_kind = 'permission' AND s.selection_key IN ('database.dump.export', 'database.dump.import')`
    )
    await database.execute(
      `UPDATE ${databaseTable("data_migration")} SET completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [migration]
    )
    await database.commit()
    return {
      alreadyApplied: false,
      removedUnsupportedSelections: result.affectedRows,
    }
  } catch (cause) {
    await database.rollback()
    throw cause
  }
}
