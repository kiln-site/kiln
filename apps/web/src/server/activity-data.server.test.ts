import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { getActivityForUser } from "@/server/activity-data.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

// The Relay is the external system: every Relay returns the same audit log
// and has no live snapshot, so names come from Hearth's instance rows.
const relayRpc = vi.hoisted(() => vi.fn())
vi.mock("@/lib/relay-connection", () => ({ relayRpc }))

const user = {
  id: "viewer",
  email: "viewer@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  name: "Viewer",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const records = [
  {
    id: "relay-event",
    details: { operation: "relay.rename", subject: "relay-actor" },
  },
  {
    id: "server-a-event",
    details: {
      instanceId: "server-a",
      operation: "instance.rename",
      subject: "actor-a",
    },
  },
  {
    id: "server-b-event",
    details: {
      instanceId: "server-b",
      operation: "instance.rename",
      subject: "actor-b",
    },
  },
].map((record) => ({
  ...record,
  event: "control.mutation",
  clientId: null,
  requestId: null,
  occurredAt: 1,
}))

interface TestGrant {
  permissions: ReadonlyArray<string>
  resourceType?: "relay" | "instance" | "database"
  resourceId?: string
  relayId?: string
}

const seed = (grants: ReadonlyArray<TestGrant>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relayRpc.mockReset()
    relayRpc.mockImplementation(async (_relay, operation) => {
      if (operation === "relay.audit.list") return records
      throw new Error("Snapshot unavailable")
    })
    yield* insertRelay("relay-a", { name: "Relay A" })
    yield* insertRelay("relay-b", { name: "Relay B" })
    for (const id of ["server-a", "server-b"]) {
      yield* insertInstance("relay-a", id, { display_name: id })
    }
    for (const id of ["relay-actor", "actor-a", "actor-b"]) {
      yield* insertUser(id)
    }
    for (const grant of grants) {
      const id = randomUUID()
      const relayId = grant.relayId ?? "relay-a"
      yield* insertGrant({
        id,
        userId: user.id,
        relayId,
        resourceType: grant.resourceType ?? "relay",
        resourceId: grant.resourceId ?? relayId,
      })
      yield* insertRows(
        "access_selection",
        grant.permissions.map((key) => ({
          access_id: id,
          selection_kind: "permission",
          selection_key: key,
        }))
      )
    }
  })

const activityFor = (viewer: AuthenticatedUser) =>
  Effect.promise(() => getActivityForUser(viewer, {}))

describeMysql("Activity permission boundary", () => {
  layer(TestDatabase)((it) => {
    for (const [label, grants, ids, actors] of [
      [
        "Relay audit reader",
        [{ permissions: ["relay.audit.read"] }],
        ["relay-event", "server-a-event", "server-b-event"],
        ["relay-actor", "actor-a", "actor-b"],
      ],
      [
        "Relay instance reader",
        [{ permissions: ["instance.read"] }],
        ["server-a-event", "server-b-event"],
        ["actor-a", "actor-b"],
      ],
      [
        "child instance reader",
        [
          {
            permissions: ["instance.read"],
            resourceType: "instance",
            resourceId: "server-a",
          },
        ],
        ["server-a-event"],
        ["actor-a"],
      ],
      [
        "database reader",
        [
          {
            permissions: ["database.read"],
            resourceType: "database",
            resourceId: "database-a",
          },
        ],
        [],
        [],
      ],
      ["ungranted reader", [], [], []],
    ] as const)
      it.effect(`limits records and actors for a ${label}`, () =>
        Effect.gen(function* () {
          yield* seed(grants)

          const result = yield* activityFor(user)

          assert.deepEqual(
            result.entries.map((entry) => entry.id),
            ids.map((id) => `relay-a:${id}`)
          )
          assert.deepEqual(
            result.entries.map((entry) => entry.actor.email),
            actors.map((id) => `${id}@example.test`)
          )
          assert.deepEqual(
            result.relays.map((relay) => relay.id),
            ids.length ? ["relay-a"] : []
          )
        })
      )

    it.effect(
      "filters child records even when the Relay returns other events",
      () =>
        Effect.gen(function* () {
          yield* seed([
            {
              permissions: ["instance.read"],
              resourceType: "instance",
              resourceId: "server-a",
            },
          ])

          const result = yield* activityFor(user)

          assert.deepEqual(
            result.servers.map((server) => server.id),
            ["server-a"]
          )
          assert.deepEqual(
            result.entries.map((entry) => entry.id),
            ["relay-a:server-a-event"]
          )
        })
    )

    it.effect(
      "does not carry Relay audit authority into another Relay with a child grant",
      () =>
        Effect.gen(function* () {
          yield* seed([
            { permissions: ["relay.audit.read"] },
            {
              permissions: ["instance.read"],
              resourceType: "instance",
              resourceId: "server-a",
              relayId: "relay-b",
            },
          ])

          const result = yield* activityFor(user)

          assert.deepEqual(
            result.entries.map((entry) => entry.id),
            [
              "relay-a:relay-event",
              "relay-a:server-a-event",
              "relay-a:server-b-event",
              "relay-b:server-a-event",
            ]
          )
        })
    )

    it.effect(
      "allows platform admins to read every Relay's activity without grants",
      () =>
        Effect.gen(function* () {
          yield* seed([])

          const result = yield* activityFor({ ...user, role: "admin" })

          assert.lengthOf(result.entries, 6)
        })
    )
  })
})
