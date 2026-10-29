import { layer } from "@effect/vitest"
import type {
  ScheduleAction,
  ScheduleTarget,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { requireScheduleAppServices } from "@/lib/schedule-app-services.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

// The App's Relay answers with its containers, or is away.
const relay = vi.hoisted(() => ({ services: null as Array<string> | null }))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation !== "app.list" || !relay.services) {
      throw new Error("Relay is offline")
    }
    return [{ app: app(relay.services), id: appId, view: "detail" }]
  },
}))

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const target: ScheduleTarget = {
  id: appId,
  kind: "app",
  name: "Shop",
  relayId,
}
const command = (service: string): ScheduleAction => ({
  authorizedTargets: 2,
  command: "./migrate",
  id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
  services: { [`${relayId}:app:${appId}`]: service },
  targetKeys: [`${relayId}:app:${appId}`],
  type: "console_command",
})

function app(services: ReadonlyArray<string>) {
  return {
    connectedDatabaseIds: [],
    containers: services.map((service, index) => ({
      createdAt: null,
      exitCode: null,
      id: `container-${index}`,
      image: "nginx:alpine",
      labels: {},
      name: `shop-${service}`,
      networks: [],
      ports: [],
      running: true,
      service,
      startedAt: null,
      state: "running",
      status: "running",
    })),
    dataDirectory: `/apps/${appId}`,
    deployment: null,
    hostname: `app-${appId.slice(0, 8)}`,
    id: appId,
    network: `app-${appId}`,
    observedState: "running",
    shortId: appId.slice(0, 8),
    status: "Running",
  }
}

describeMysql("scheduled App services", () => {
  layer(TestDatabase)((it) => {
    const check = (
      actions: ReadonlyArray<ScheduleAction>,
      existing?: ReadonlyArray<ScheduleAction>
    ) =>
      Effect.promise(() =>
        requireScheduleAppServices({
          actions,
          ...(existing ? { existing: { actions: existing } } : {}),
          targets: [target],
        }).then(
          () => null,
          (cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause)
        )
      )

    it.effect(
      "keeps a schedule to the services its App runs, and to the ones it saved while the Relay is away",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId, { enabled: true })

          relay.services = ["web", "worker"]
          expect(yield* check([command("worker")])).toBeNull()
          expect(yield* check([command("cron")])).toBe(
            "Shop has no service named cron"
          )

          relay.services = null
          expect(yield* check([command("worker")])).toBe(
            "Shop's Relay must be online to check its services"
          )
          // An edit that keeps the service it saved stays possible.
          expect(
            yield* check([command("worker")], [command("worker")])
          ).toBeNull()
          expect(yield* check([command("web")], [command("worker")])).toBe(
            "Shop's Relay must be online to check its services"
          )
        }),
      60_000
    )
  })
})
