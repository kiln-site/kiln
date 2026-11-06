import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import { relayResourceLimitsV1Feature } from "@workspace/contracts"

import {
  dismissNotificationEffect,
  listNotificationsEffect,
} from "@/effect/notifications"
import { warnDatabasesOverDiskLimitEffect } from "@/lib/disk-limit-warnings.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

const relay = vi.hoisted(() => ({
  listed: null as Array<{ diskUsedBytes: number | null }> | null,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayResourceLimitsV1Feature]),
  relayRpc: async () => {
    if (!relay.listed) throw new Error("The Relay is away")
    return relay.listed.map(({ diskUsedBytes }) => ({
      containerId: null,
      createdAt: new Date(0).toISOString(),
      databaseName: "kiln_main",
      diskUsedBytes,
      engine: "postgres",
      hostname: "database",
      id: "d".repeat(40),
      image: "postgres:17",
      internalPort: 5432,
      limits: { diskBytes: 100 },
      members: [],
      name: "Main",
      observedState: "running",
      shortId: "dddddddd",
      status: "Running",
      supportsImportExport: true,
    }))
  },
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const check = (listed: typeof relay.listed) =>
  Effect.suspend(() => {
    relay.listed = listed
    return warnDatabasesOverDiskLimitEffect()
  })

const usage = Effect.map(listNotificationsEffect("admin"), (notifications) =>
  notifications.flatMap(({ content }) =>
    content.kind === "resource.disk-limit" ? [content.usedBytes] : []
  )
)

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("admin", { role: "admin" })
  yield* insertRelay("r".repeat(43))
})

describeMysql("disk limit warnings", () => {
  layer(TestDatabase)((it) => {
    it.effect("warn once, follow the usage, and go once the data fits", () =>
      Effect.gen(function* () {
        yield* seed
        yield* check([{ diskUsedBytes: 120 }])
        yield* check([{ diskUsedBytes: 150 }])
        assert.deepStrictEqual(yield* usage, [150])

        yield* check([{ diskUsedBytes: 50 }])
        assert.deepStrictEqual(yield* usage, [])
      })
    )

    it.effect("warn again when the data outgrows the limit again", () =>
      Effect.gen(function* () {
        yield* seed
        yield* check([{ diskUsedBytes: 120 }])
        const [warning] = yield* listNotificationsEffect("admin")
        yield* dismissNotificationEffect("admin", warning?.id ?? "")
        yield* check([{ diskUsedBytes: 50 }])
        yield* check([{ diskUsedBytes: 120 }])
        assert.deepStrictEqual(yield* usage, [120])
      })
    )

    it.effect("stay while it can't be known whether the data fits", () =>
      Effect.gen(function* () {
        yield* seed
        yield* check([{ diskUsedBytes: 120 }])
        const [warning] = yield* listNotificationsEffect("admin")

        // A Relay that just started hasn't measured, or isn't there.
        yield* check([{ diskUsedBytes: null }])
        yield* check(null)
        assert.deepStrictEqual(yield* usage, [120])

        // Cleared, it stays cleared through the same ongoing overflow.
        yield* dismissNotificationEffect("admin", warning?.id ?? "")
        yield* check([{ diskUsedBytes: null }])
        yield* check([{ diskUsedBytes: 130 }])
        assert.deepStrictEqual(yield* usage, [])
      })
    )
  })
})
