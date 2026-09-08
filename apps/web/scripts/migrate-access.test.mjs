import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  databaseConnectionConfig,
  databaseTable,
  prefixAppMigrationSql,
  prefixAuthMigrationSql,
} from "./database-config.mjs"
import {
  backfillAccessModel,
  projectLegacyDatabasePermissions,
  ensureAccessModelSchema,
} from "./migrate-access.mjs"
import { legacyAccessPermissions } from "./legacy-access-permissions.mjs"

test("legacy permissions are frozen explicit selections and preserve split operations", () => {
  for (const engine of ["redis", "valkey"]) {
    assert.ok(
      !legacyAccessPermissions("operator", "database", engine).some((key) =>
        key.startsWith("database.dump.")
      )
    )
    assert.ok(
      legacyAccessPermissions("operator", "relay", engine).includes(
        "database.dump.export"
      )
    )
  }
  assert.ok(
    legacyAccessPermissions("operator", "database", "postgres").includes(
      "database.dump.import"
    )
  )
  const operator = legacyAccessPermissions("operator", "instance")
  assert.ok(operator.includes("instance.power.kill"))
  assert.ok(operator.includes("instance.files.delete"))
  assert.ok(operator.includes("instance.files.chmod"))
  assert.ok(!operator.includes("access.invite"))
  assert.ok(!operator.some((key) => key.startsWith("database.")))
  assert.ok(!operator.some((key) => key.includes("ALL")))
  assert.ok(
    !legacyAccessPermissions("viewer", "database").includes(
      "database.credentials.read"
    )
  )
  assert.ok(!legacyAccessPermissions("admin", "relay").includes("relay.delete"))
})

test(
  "MySQL migration preserves identities, evidence, timed status and reruns without restoring grants",
  { skip: process.env.ACCESS_MIGRATION_TEST !== "1" },
  async () => {
    const { default: mysql } = await import("mysql2/promise")
    // Caller must provision an isolated database and explicitly opt into this fixture.
    assert.match(process.env.DB_NAME ?? "", /migration_test$/)
    const db = await mysql.createConnection({
      ...databaseConnectionConfig(),
      multipleStatements: true,
      timezone: "Z",
    })
    try {
      await db.query("SET SESSION time_zone = '+00:00'")
      const [tables] = await db.query("SHOW TABLES")
      await db.query("SET FOREIGN_KEY_CHECKS = 0")
      for (const table of tables)
        await db.query(`DROP TABLE \`${Object.values(table)[0]}\``)
      await db.query("SET FOREIGN_KEY_CHECKS = 1")
      // Strip new fields to exercise an actual legacy upgrade, rather than only new installs.
      let auth = await readFile(
        new URL("../migrations/auth.sql", import.meta.url),
        "utf8"
      )
      auth = auth.replace(
        /, `status` VARCHAR\(16\).*?`legacyVerificationRecordedAt` TIMESTAMP\(3\) NULL/,
        ""
      )
      await db.query(prefixAuthMigrationSql(auth))
      let app = await readFile(
        new URL("../migrations/app.sql", import.meta.url),
        "utf8"
      )
      app = app
        .replace(/  state ENUM\('pending', 'active', 'revoked'\).*?\n/, "")
        .replace(/  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,\n/, "")
      app = app.replace(
        /  access_id CHAR\(36\) NULL,\n[\s\S]*?  sent_at TIMESTAMP\(3\) NULL,\n/,
        ""
      )
      app = app.replace(
        /  KEY kiln_invitation_(access_expiry|user_access|delivery)_idx .*\n/gu,
        ""
      )
      app = app.replace(
        /  KEY kiln_access_grant_(scope_state|user_state)_idx .*\n/gu,
        ""
      )
      await db.query(prefixAppMigrationSql(app))
      await db.execute(
        `INSERT INTO ${databaseTable("user")} (id,name,email,emailVerified,banned,banExpires) VALUES ('old','Old',' Old@Example.test ',TRUE,TRUE,DATE_ADD(NOW(3), INTERVAL 1 DAY)), ('expired','Expired','expired@example.test',TRUE,TRUE,DATE_SUB(NOW(3), INTERVAL 1 DAY))`
      )
      await db.execute(
        `INSERT INTO ${databaseTable("session")} (id,userId,token,expiresAt,updatedAt) VALUES ('session','old','preserved',DATE_ADD(NOW(3), INTERVAL 1 DAY),NOW(3))`
      )
      await db.execute(
        `INSERT INTO ${databaseTable("access_grant")} (id,user_id,relay_id,resource_type,resource_id,role) VALUES ('grant','old','relay','instance','instance','operator')`
      )
      await db.execute(
        `INSERT INTO ${databaseTable("invitation")} (id,token_hash,email,relay_id,instance_id,role,invited_by,expires_at) VALUES ('invite',REPEAT('a',64),' Invited@example.test ','relay','instance','viewer','old',DATE_ADD(NOW(3),INTERVAL 1 DAY)), ('platform',REPEAT('b',64),'Invited@example.test',NULL,NULL,NULL,'old',DATE_ADD(NOW(3),INTERVAL 1 DAY))`
      )
      await db.execute(
        `UPDATE ${databaseTable("invitation")} SET access_type='platform_admin' WHERE id='platform'`
      )
      await db.execute(
        `INSERT INTO ${databaseTable("relay")} (id,name,hostname,browser_origin,relay_public_key,client_id,client_public_key,client_private_key_ciphertext,client_role,client_actions) VALUES ('relay','Fixture','fixture.invalid','https://fixture.invalid','key','client','key','cipher','full_access',JSON_ARRAY())`
      )
      for (const engine of ["redis", "valkey", "postgres"]) {
        await db.execute(
          `INSERT INTO ${databaseTable("database")} (database_id,relay_id,name,engine,database_name,username,password_ciphertext,created_by) VALUES (?,'relay',?,?,?,'fixture','cipher','old')`,
          [engine, engine, engine, engine]
        )
        await db.execute(
          `INSERT INTO ${databaseTable("access_grant")} (id,user_id,relay_id,resource_type,resource_id,role) VALUES (?,'old','relay','database',?,'operator')`,
          [engine, engine]
        )
      }
      await db.execute(
        `INSERT INTO ${databaseTable("access_grant")} (id,user_id,relay_id,resource_type,resource_id,role) VALUES ('relay-grant','old','relay','relay','relay','operator')`
      )
      await ensureAccessModelSchema(db)
      const first = await backfillAccessModel(db)
      assert.equal(first.alreadyApplied, false)
      const [users] = await db.query(
        `SELECT * FROM ${databaseTable("user")} ORDER BY id`
      )
      const old = users.find((user) => user.id === "old")
      assert.equal(old.email, "old@example.test")
      assert.equal(old.status, "disabled")
      assert.ok(old.statusExpiresAt)
      assert.equal(old.banned, 0)
      assert.ok(old.legacyVerificationRecordedAt)
      assert.equal(old.emailVerifiedAt, null)
      assert.equal(old.manuallyVerifiedAt, null)
      assert.equal(
        users.find((user) => user.id === "expired").status,
        "enabled"
      )
      assert.equal(users.length, 3)
      const invited = users.find(
        (user) => user.email === "invited@example.test"
      )
      assert.equal(invited.emailVerified, 0)
      assert.equal(invited.legacyVerificationRecordedAt, null)
      const [invites] = await db.query(
        `SELECT * FROM ${databaseTable("invitation")} ORDER BY id`
      )
      assert.equal(invites[0].user_id, invited.id)
      assert.equal(invites[1].user_id, invited.id)
      assert.equal(invites[0].token_hash, "a".repeat(64))
      assert.equal(invites[1].access_type, "platform_admin")
      const [grants] = await db.query(
        `SELECT * FROM ${databaseTable("access_grant")} WHERE state = 'pending'`
      )
      assert.equal(grants[0].state, "pending")
      await db.query(
        `DELETE FROM ${databaseTable("access_selection")} WHERE access_id='grant'`
      )
      await db.query(
        `UPDATE ${databaseTable("user")} SET legacyVerificationRecordedAt=NULL WHERE id='old'`
      )
      await ensureAccessModelSchema(db)
      assert.deepEqual(await backfillAccessModel(db), { alreadyApplied: true })
      const [selections] = await db.query(
        `SELECT * FROM ${databaseTable("access_selection")} WHERE access_id='grant'`
      )
      assert.equal(selections.length, 0)
      const [sessions] = await db.query(
        `SELECT token FROM ${databaseTable("session")}`
      )
      assert.equal(sessions[0].token, "preserved")
      const [accounts] = await db.query(
        `SELECT * FROM ${databaseTable("account")}`
      )
      assert.equal(accounts.length, 0)
      await assert.rejects(
        db.execute(
          `INSERT INTO ${databaseTable("access_preset")} (id, access_id) VALUES ('invalid', 'grant')`
        ),
        /check constraint/iu
      )
      const [engineSelections] = await db.query(
        `SELECT access_id FROM ${databaseTable("access_selection")} WHERE selection_key='database.dump.export' ORDER BY access_id`
      )
      assert.deepEqual(
        engineSelections.map((row) => row.access_id),
        ["postgres", "relay-grant"]
      )
      // Simulate a previous v1 deployment with unsupported keys already stored.
      for (const access of ["redis", "valkey"]) {
        await db.execute(
          `INSERT INTO ${databaseTable("access_selection")} (access_id,selection_kind,selection_key) VALUES (?,'permission','database.dump.export'),(?,'permission','database.dump.import')`,
          [access, access]
        )
      }
      assert.deepEqual(await projectLegacyDatabasePermissions(db), {
        alreadyApplied: false,
        removedUnsupportedSelections: 4,
      })
      const [projected] = await db.query(
        `SELECT access_id FROM ${databaseTable("access_selection")} WHERE selection_key='database.dump.export' ORDER BY access_id`
      )
      assert.deepEqual(
        projected.map((row) => row.access_id),
        ["postgres", "relay-grant"]
      )
      assert.deepEqual(await projectLegacyDatabasePermissions(db), {
        alreadyApplied: true,
      })
      await db.execute(
        `UPDATE ${databaseTable("data_migration")} SET completed_at=NULL WHERE id='access-permissions-v1'`
      )
      await db.execute(
        `INSERT INTO ${databaseTable("user")} (id,name,email,emailVerified) VALUES ('collision','Collision',' old@example.test',FALSE)`
      )
      await assert.rejects(
        backfillAccessModel(db),
        /normalized user email collisions/u
      )
      const [markers] = await db.query(
        `SELECT completed_at FROM ${databaseTable("data_migration")} WHERE id='access-permissions-v1'`
      )
      assert.equal(markers[0].completed_at, null)
    } finally {
      await db.end()
    }
  }
)
