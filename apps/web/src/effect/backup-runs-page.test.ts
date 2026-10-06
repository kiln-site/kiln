import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  type BackupCatalogPageInput,
  type BackupCatalogPageRecord,
  listBackupCatalogPageEffect,
} from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertInstance,
  insertRelay,
  insertRows,
} from "@/test/seed"

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

    it.effect("matches search text literally and filters by status", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertCatalogBackup("s-match", { name: "100%_safe nightly" })
        // Would match if % and _ were wildcards.
        yield* insertCatalogBackup("s-wildcard", { name: "100ab-safe" })
        yield* insertCatalogBackup("s-failed", {
          name: "100%_safe failed",
          status: "failed",
        })
        yield* insertCatalogBackup(
          "s-running",
          { name: "100%_safe running" },
          "running"
        )

        const search = "100%_safe"
        assert.deepStrictEqual(
          yield* pageIds({ search, status: "available" }),
          ["s-match"]
        )
        assert.deepStrictEqual(yield* pageIds({ search, status: "failed" }), [
          "s-failed",
        ])
        assert.deepStrictEqual(yield* pageIds({ search, status: "active" }), [
          "s-running",
        ])
        assert.sameMembers(yield* pageIds({ search }), [
          "s-match",
          "s-failed",
          "s-running",
        ])
      })
    )

    it.effect(
      "pages through every sort and direction without gaps or repeats",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-a")
          const specs = [
            { id: "b1", name: "alpha", bytes: 300, created: 1, source: "Zeta" },
            {
              id: "b2",
              name: "Bravo",
              bytes: null,
              created: 2,
              source: "beta",
            },
            {
              id: "b3",
              name: "charlie",
              bytes: 100,
              created: 3,
              source: "Beta",
            },
            {
              id: "b4",
              name: "bravo",
              bytes: 300,
              created: 3,
              source: "alpha",
            },
            { id: "b5", name: "delta", bytes: null, created: 5, source: null },
            { id: "b6", name: "Echo", bytes: 50, created: 6, source: "gamma" },
          ]
          for (const spec of specs) {
            yield* insertInstance("relay-a", `inst-${spec.id}`, {
              source_name: spec.source,
            })
            yield* insertCatalogBackup(spec.id, {
              relay_id: "relay-a",
              target_id: `inst-${spec.id}`,
              name: spec.name,
              bytes: spec.bytes,
              created_at: at + spec.created,
            })
          }

          type Spec = (typeof specs)[number]
          const compareText = (left: string, right: string) =>
            left < right ? -1 : left > right ? 1 : 0
          const sortKeys: Record<
            BackupCatalogPageInput["sort"],
            (spec: Spec) => number | string | null
          > = {
            createdAt: (spec) => spec.created,
            name: (spec) => spec.name.toLowerCase(),
            size: (spec) => spec.bytes,
            target: (spec) => (spec.source ?? "").toLowerCase(),
          }
          const expectedOrder = (
            sort: BackupCatalogPageInput["sort"],
            direction: "asc" | "desc"
          ) => {
            const sign = direction === "asc" ? 1 : -1
            return [...specs]
              .sort((left, right) => {
                const a = sortKeys[sort](left)
                const b = sortKeys[sort](right)
                // Backups without a size come last in either direction.
                if (a === null || b === null) {
                  if (a !== b) return a === null ? 1 : -1
                } else if (a !== b) {
                  return (
                    sign *
                    (typeof a === "number" && typeof b === "number"
                      ? a - b
                      : compareText(String(a), String(b)))
                  )
                }
                return sign * compareText(left.id, right.id)
              })
              .map((spec) => spec.id)
          }

          for (const sort of ["createdAt", "name", "size", "target"] as const) {
            for (const direction of ["asc", "desc"] as const) {
              const seen: Array<string> = []
              let cursor: BackupCatalogPageInput["cursor"] = null
              for (let page = 0; page < specs.length; page += 1) {
                const result: {
                  hasMore: boolean
                  items: ReadonlyArray<BackupCatalogPageRecord>
                } = yield* listBackupCatalogPageEffect(
                  pageInput({ cursor, direction, limit: 2, sort })
                )
                seen.push(...result.items.map((item) => item.record.id))
                const last = result.items.at(-1)
                if (!result.hasMore || !last) break
                cursor = { id: last.record.id, value: last.orderValue }
              }
              assert.deepStrictEqual(
                seen,
                expectedOrder(sort, direction),
                `${sort} ${direction}`
              )
            }
          }
        })
    )
  })
})
