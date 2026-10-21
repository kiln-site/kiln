import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import { listNotificationsEffect } from "@/effect/notifications"
import type { AccessPermission } from "@/lib/permissions"
import { warnDatabasesOverDiskLimitEffect } from "@/lib/disk-limit-warnings.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

// The Relay is the boundary: it reports its databases, their limits, and how
// much each one's data holds.
const relay = vi.hoisted(() => ({
  databases: [] as Array<unknown>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () =>
    new Set(["resource-limits-v1"]),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation === "database.list") return relay.databases
    throw new Error(`Unexpected Relay operation ${operation}`)
  },
}))

const relayId = "r".repeat(43)
const databaseId = "d".repeat(40)
const GIBIBYTE = 1024 ** 3

const relayDatabase = (usedBytes: number) => ({
  connectedInstanceIds: [],
  containerId: "container",
  createdAt: new Date(0).toISOString(),
  databaseName: "kiln_main",
  diskUsedBytes: usedBytes,
  engine: "postgres",
  hostname: "kiln-db-main",
  id: databaseId,
  image: "postgres:17",
  internalPort: 5432,
  limits: { cpuMillis: null, diskBytes: GIBIBYTE, memoryBytes: null },
  name: "Main",
  observedState: "running",
  shortId: databaseId.slice(0, 8),
  status: "Ready",
  supportsImportExport: true,
})

const grant = (
  userId: string,
  target: "relay" | "database",
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: target === "relay" ? relayId : databaseId,
      resourceType: target,
      userId,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_key: permission,
        selection_kind: "permission",
      }))
    )
  })

const warned = (userId: string) =>
  Effect.map(listNotificationsEffect(userId), (notifications) =>
    notifications.filter(
      (notification) => notification.content.kind === "resource.disk-limit"
    )
  )

describeMysql("database disk limit warnings", () => {
  layer(TestDatabase)((it) => {
    it.effect("warns those who can see the database, once per limit", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        // The Relay's creator owns it; the database's creator has no access
        // of their own.
        yield* insertRelay(relayId, { created_by: "owner", enabled: true })
        for (const user of [
          "owner",
          "creator",
          "reader",
          "relay-reader",
          "outsider",
        ]) {
          yield* insertUser(user)
        }
        yield* insertRows("database", {
          created_at: 0,
          created_by: "creator",
          database_id: databaseId,
          database_name: "kiln_main",
          engine: "postgres",
          name: "Main",
          password_ciphertext: "ciphertext",
          relay_id: relayId,
          updated_at: 0,
          username: "kiln_user",
        })
        yield* grant("reader", "database", ["database.read"])
        yield* grant("relay-reader", "relay", ["database.read"])
        // A Relay grant that reaches only game servers.
        yield* grant("outsider", "relay", ["instance.console.read"])

        relay.databases = [relayDatabase(GIBIBYTE / 2)]
        yield* warnDatabasesOverDiskLimitEffect()
        assert.lengthOf(yield* warned("owner"), 0)

        relay.databases = [relayDatabase(2 * GIBIBYTE)]
        yield* warnDatabasesOverDiskLimitEffect()
        yield* warnDatabasesOverDiskLimitEffect()

        for (const user of ["owner", "reader", "relay-reader"]) {
          const notifications = yield* warned(user)
          assert.lengthOf(notifications, 1, user)
          assert.deepInclude(notifications[0]?.content, {
            limitBytes: GIBIBYTE,
            usedBytes: 2 * GIBIBYTE,
          })
        }
        assert.lengthOf(yield* warned("outsider"), 0)
        assert.lengthOf(yield* warned("creator"), 0)
      })
    )
  })
})
