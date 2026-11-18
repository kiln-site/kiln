import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { ensureInstallationId } from "@/effect/installation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"

afterEach(() => {
  vi.unstubAllEnvs()
})

describeMysql("Installation ID", () => {
  layer(TestDatabase)((it) => {
    it.effect("generates one ID that every later start keeps", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("KILN_INSTALLATION_ID", "")

        const generated = yield* ensureInstallationId()
        const restarted = yield* ensureInstallationId()

        assert.match(generated, /^[0-9a-f-]{36}$/u)
        assert.strictEqual(restarted, generated)
      })
    )

    it.effect("keeps KILN_INSTALLATION_ID after the variable is removed", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("KILN_INSTALLATION_ID", "")
        yield* ensureInstallationId()

        vi.stubEnv("KILN_INSTALLATION_ID", "kiln-production")
        const configured = yield* ensureInstallationId()
        vi.stubEnv("KILN_INSTALLATION_ID", "")
        const removed = yield* ensureInstallationId()

        assert.strictEqual(configured, "kiln-production")
        assert.strictEqual(removed, "kiln-production")
      })
    )

    it.effect(
      "moves Kiln's own backups to the ID it was restored under, once",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          vi.stubEnv("KILN_INSTALLATION_ID", "kiln-lost")
          yield* ensureInstallationId()
          yield* insertBackup("00000000-0000-4000-8000-000000000001", {
            artifact_kind: "platform_bundle",
            target_id: "kiln-lost",
            target_kind: "platform",
          })
          yield* insertBackup("00000000-0000-4000-8000-000000000002")
          // Its settings, and an older installation's left behind.
          for (const [id, kept] of [
            ["kiln-older", "older"],
            ["kiln-lost", "lost"],
          ]) {
            yield* insertRows("backup_policy", {
              created_at: 0,
              exclude_patterns: JSON.stringify([kept]),
              relay_id: "relay-one",
              target_id: id,
              target_kind: "platform",
              updated_at: 0,
            })
          }
          // A schedule its Relay acknowledged before the machine was lost.
          yield* insertRelay("relay-one")
          yield* insertRows("schedule", {
            created_at: 0,
            created_by: "admin",
            cron_expression: "0 3 * * *",
            enabled: true,
            id: "00000000-0000-4000-8000-0000000000c1",
            name: "Back up Kiln",
            revision: 1,
            updated_at: 0,
          })
          yield* insertRows("schedule_deployment", {
            acknowledged_revision: 1,
            created_at: 0,
            desired_revision: 1,
            relay_id: "relay-one",
            schedule_id: "00000000-0000-4000-8000-0000000000c1",
            status: "applied",
            updated_at: 0,
          })
          const targets = Effect.gen(function* () {
            const backups = yield* selectRows<{ id: string; target_id: string }>(
              "backup"
            )
            const policies = yield* selectRows<{
              exclude_patterns: unknown
              target_id: string
            }>("backup_policy")
            const deployments = yield* selectRows<{ status: string }>(
              "schedule_deployment"
            )
            return {
              backups: Object.fromEntries(
                backups.map((row) => [row.id.slice(-1), row.target_id])
              ),
              policies: Object.fromEntries(
                policies.map((row) => [
                  row.target_id,
                  JSON.stringify(row.exclude_patterns).replace(/\W/gu, ""),
                ])
              ),
              schedules: deployments.map((row) => row.status),
            }
          })

          // An ID changed by hand takes nothing with it.
          vi.stubEnv("KILN_INSTALLATION_ID", "kiln-other")
          yield* ensureInstallationId()
          assert.deepStrictEqual(yield* targets, {
            backups: { 1: "kiln-lost", 2: "instance-one" },
            policies: { "kiln-lost": "lost", "kiln-older": "older" },
            schedules: ["applied"],
          })

          // Restored, from the installation that made them.
          vi.stubEnv("KILN_INSTALLATION_ID", "kiln-lost")
          yield* ensureInstallationId()
          vi.stubEnv("KILN_INSTALLATION_ID", "kiln-restored")
          vi.stubEnv("KILN_PREVIOUS_INSTALLATION_IDS", "kiln-older,kiln-lost")
          yield* ensureInstallationId()
          // The newest earlier installation's settings win, and its Relay
          // is sent its schedules again.
          assert.deepStrictEqual(yield* targets, {
            backups: { 1: "kiln-restored", 2: "instance-one" },
            policies: { "kiln-restored": "lost" },
            schedules: ["pending"],
          })
        })
    )
  })
})
