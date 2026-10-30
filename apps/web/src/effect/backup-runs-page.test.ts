import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  type BackupCatalogPageInput,
  listBackupCatalogPageEffect,
} from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRows } from "@/test/seed"

const at = 1_767_225_600_000

// The catalog lists a backup through its latest task.
const insertCatalogBackup = (
  id: string,
  row: Parameters<typeof insertBackup>[1] = {},
  taskStatus = "succeeded"
) =>
  Effect.gen(function* () {
    yield* insertBackup(id, row)
    yield* insertRows("backup_task", {
      id: `${id}-task`,
      backup_id: id,
      task_kind: "create",
      status: taskStatus,
      created_at: at,
      updated_at: at,
    })
  })

const pageInput = (
  input: Partial<BackupCatalogPageInput>
): BackupCatalogPageInput => ({
  allowedScopes: [],
  appScopes: [],
  cursor: null,
  direction: "desc",
  isAdmin: true,
  limit: 50,
  scope: null,
  search: "",
  sort: "createdAt",
  status: null,
  userId: "user-a",
  ...input,
})

const pageIds = (input: Partial<BackupCatalogPageInput>) =>
  listBackupCatalogPageEffect(pageInput(input)).pipe(
    Effect.map((page) => page.items.map((item) => item.record.id))
  )

describeMysql("backup runs page", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "lists an App's backups only to those who can read the App, and a Kiln volume's to the Relay's backup readers",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const website = "a".repeat(40)
          const worker = "b".repeat(40)
          const shared = "c".repeat(40)
          const tar = { artifact_kind: "tar_archive", relay_id: "relay-a" }
          yield* insertCatalogBackup("website", {
            ...tar,
            target_id: website,
            target_kind: "app",
          })
          yield* insertCatalogBackup("website-db", {
            ...tar,
            target_id: `${website}/pgdata`,
            target_kind: "volume",
          })
          yield* insertCatalogBackup("worker", {
            ...tar,
            target_id: worker,
            target_kind: "app",
          })
          yield* insertCatalogBackup("shared", {
            ...tar,
            target_id: shared,
            target_kind: "volume",
          })
          yield* insertCatalogBackup("server", {
            relay_id: "relay-a",
            target_id: "inst-a",
          })
          const relayBackups = [
            {
              relayId: "relay-a",
              resourceType: "relay" as const,
              resourceId: "relay-a",
            },
          ]

          // The Relay's backup readers see a Kiln volume's, never an App's.
          assert.sameMembers(
            yield* pageIds({ allowedScopes: relayBackups, isAdmin: false }),
            ["server", "shared"]
          )
          assert.sameMembers(
            yield* pageIds({
              appScopes: [{ appId: website, relayId: "relay-a" }],
              isAdmin: false,
            }),
            ["website", "website-db"]
          )
          assert.sameMembers(
            yield* pageIds({
              appScopes: [{ appId: null, relayId: "relay-a" }],
              isAdmin: false,
            }),
            ["website", "website-db", "worker"]
          )
          // A volume filter narrows the result but never grants access.
          const scope = {
            kind: "volume" as const,
            relayId: "relay-a",
            targetId: `${website}/pgdata`,
          }
          assert.deepStrictEqual(
            yield* pageIds({
              scope,
              isAdmin: false,
              allowedScopes: relayBackups,
            }),
            []
          )
          assert.deepStrictEqual(
            yield* pageIds({
              scope,
              isAdmin: false,
              appScopes: [{ appId: worker, relayId: "relay-a" }],
            }),
            []
          )
          assert.deepStrictEqual(
            yield* pageIds({
              scope,
              isAdmin: false,
              appScopes: [{ appId: website, relayId: "relay-a" }],
            }),
            ["website-db"]
          )
          const sharedScope = {
            kind: "volume" as const,
            relayId: "relay-a",
            targetId: shared,
          }
          assert.deepStrictEqual(
            yield* pageIds({
              scope: sharedScope,
              isAdmin: false,
              appScopes: [{ appId: website, relayId: "relay-a" }],
            }),
            []
          )
          assert.deepStrictEqual(
            yield* pageIds({
              scope: sharedScope,
              isAdmin: false,
              allowedScopes: relayBackups,
            }),
            ["shared"]
          )
          assert.deepStrictEqual(
            yield* pageIds({
              appScopes: [{ appId: website, relayId: "relay-b" }],
              isAdmin: false,
            }),
            []
          )
        })
    )

    it.effect("shows non-admins only backups their grants cover", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertCatalogBackup("a-inst-a", {
          relay_id: "relay-a",
          target_id: "inst-a",
        })
        yield* insertCatalogBackup("a-inst-b", {
          relay_id: "relay-a",
          target_id: "inst-b",
        })
        yield* insertCatalogBackup("a-db", {
          relay_id: "relay-a",
          target_kind: "database",
          target_id: "inst-a",
          artifact_kind: "database_dump",
        })
        yield* insertCatalogBackup("a-platform", {
          relay_id: "relay-a",
          target_kind: "platform",
          target_id: "kiln.dev",
          artifact_kind: "platform_bundle",
        })
        yield* insertCatalogBackup("b-inst", {
          relay_id: "relay-b",
          target_id: "inst-x",
        })
        yield* insertCatalogBackup("b-platform", {
          relay_id: "relay-b",
          target_kind: "platform",
          target_id: "kiln.dev",
          artifact_kind: "platform_bundle",
        })
        yield* insertCatalogBackup("c-inst", {
          relay_id: "relay-c",
          target_id: "inst-a",
        })
        const allowedScopes = [
          {
            relayId: "relay-a",
            resourceType: "instance" as const,
            resourceId: "inst-a",
          },
          {
            relayId: "relay-b",
            resourceType: "relay" as const,
            resourceId: "relay-b",
          },
          {
            relayId: "relay-b",
            resourceType: "instance" as const,
            resourceId: "inst-x",
          },
        ]

        assert.sameMembers(yield* pageIds({ isAdmin: false, allowedScopes }), [
          "a-inst-a",
          "b-inst",
        ])
        assert.deepStrictEqual(yield* pageIds({ isAdmin: false }), [])
        // A requested scope narrows the grants; it never widens them.
        assert.deepStrictEqual(
          yield* pageIds({
            isAdmin: false,
            allowedScopes,
            scope: { kind: "instance", relayId: "relay-a", targetId: "inst-b" },
          }),
          []
        )
        // A whole-kind scope also stays inside the grants.
        assert.sameMembers(
          yield* pageIds({
            isAdmin: false,
            allowedScopes,
            scope: { kind: "instance" },
          }),
          ["a-inst-a", "b-inst"]
        )
        assert.deepStrictEqual(
          yield* pageIds({
            isAdmin: false,
            allowedScopes,
            scope: { kind: "platform" },
          }),
          []
        )
        assert.sameMembers(
          yield* pageIds({ isAdmin: true, scope: { kind: "platform" } }),
          ["a-platform", "b-platform"]
        )
        assert.sameMembers(yield* pageIds({ isAdmin: true }), [
          "a-inst-a",
          "a-inst-b",
          "a-db",
          "a-platform",
          "b-inst",
          "b-platform",
          "c-inst",
        ])
      })
    )
  })
})
