import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../apps/web/scripts/migrate-app.mjs"
  ),
  "utf8"
)

test("adds the restic storage unique key before dropping the legacy unique", () => {
  const add = source.indexOf(
    'ADD UNIQUE KEY ${databaseTable("backup_repository_target_storage_unique")}'
  )
  const drop = source.indexOf(
    'DROP INDEX ${databaseTable("backup_repository_target_unique")}'
  )

  assert.notEqual(add, -1)
  assert.notEqual(drop, -1)
  assert.ok(add < drop)
})

test("adds the running state to schedule run status", () => {
  assert.match(
    source,
    /MODIFY status ENUM\('running', 'succeeded', 'partial', 'failed', 'noop', 'interrupted', 'missed'\)/
  )
})

test("migrates prepared-instance ownership reservations", () => {
  assert.match(
    source,
    /ADD COLUMN provisioning_reserved_until TIMESTAMP\(3\) NULL AFTER owner_id/
  )
})
