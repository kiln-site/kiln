import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import type { CliPrincipal } from "@/effect/cli-access"
import { listCliBackupsEffect } from "@/effect/cli-api"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows } from "@/test/seed"

// The Relay is offline, so listing reads the catalog as Hearth keeps it.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async () => {
    throw new Error("Relay is offline")
  },
}))

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const relayId = "r".repeat(43)

const principal: CliPrincipal = {
  credentialId: "62d3fa60-eec3-4767-943d-c6ec159c5322",
  mode: "read_only",
  user: {
    email: "admin@example.test",
    emailVerified: true,
    emailVerifiedAt: new Date(at).toISOString(),
    id: "admin",
    isDevelopmentBypass: false,
    name: "Admin",
    role: "admin",
    status: "enabled",
    twoFactorEnabled: false,
  },
}

describeMysql("CLI backup listing", () => {
  layer(TestDatabase)((it) => {
    it.effect("lists a backup of an App's volume with a long ID", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        // An App's volume: the App's ID, then its name in Compose.
        const volumeId = `${"a".repeat(40)}/${"v".repeat(128)}`
        const backupId = "00000000-0000-4000-8000-000000000001"
        yield* insertBackup(backupId, {
          artifact_kind: "tar_archive",
          relay_id: relayId,
          target_id: volumeId,
          target_kind: "volume",
        })
        yield* insertRows("backup_artifact", {
          backup_id: backupId,
          created_at: at,
          destination_key: "local",
          id: "00000000-0000-4000-8000-000000000003",
          status: "available",
          updated_at: at,
        })
        yield* insertRows("backup_task", {
          backup_id: backupId,
          created_at: at,
          id: "00000000-0000-4000-8000-000000000002",
          status: "succeeded",
          task_kind: "create",
          updated_at: at,
        })

        const { backups } = yield* listCliBackupsEffect(principal, 50)

        assert.deepStrictEqual(
          backups.map((backup) => [backup.targetKind, backup.targetId]),
          [["volume", volumeId]]
        )
      })
    )
  })
})
