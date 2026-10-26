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

    // server-a was copied to relay-b as server-copy, which the viewer can
    // see; server-a itself they can't.
    const seedCopy = (keepActivity: boolean, finishedAt = 5) =>
      Effect.gen(function* () {
        yield* seed([
          {
            permissions: ["instance.read"],
            relayId: "relay-b",
            resourceId: "server-copy",
            resourceType: "instance",
          },
        ])
        yield* insertInstance("relay-b", "server-copy", {
          display_name: "server-copy",
        })
        yield* insertRows("server_migration", {
          actor: JSON.stringify(user),
          claim_generation: 1,
          create_key: randomUUID(),
          created_at: 1,
          destination_instance_id: "server-copy",
          destination_name: "server-copy",
          destination_relay_id: "relay-b",
          finished_at: finishedAt,
          id: randomUUID(),
          mode: "migrate",
          options: JSON.stringify({
            backup: null,
            copyAccess: false,
            keepActivity,
            moveDomain: false,
            moveWebRoutes: false,
            stopSource: true,
          }),
          requested_by: user.id,
          source_instance_id: "server-a",
          source_name: "server-a",
          source_relay_id: "relay-a",
          state: "completed",
          step: "finish",
          updated_at: 1,
        })
      })

    it.effect(
      "shows a copied server's earlier history as the copy's, to those who can see the copy",
      () =>
        Effect.gen(function* () {
          yield* seedCopy(true)

          const result = yield* activityFor(user)

          assert.deepEqual(
            result.entries.map((entry) => ({
              id: entry.id,
              relay: entry.relay.id,
              target: entry.target?.id,
            })),
            [
              {
                id: "relay-a:server-a-event:relay-b:server-copy",
                relay: "relay-b",
                target: "server-copy",
              },
            ]
          )
        })
    )

    it.effect(
      "marks a copied server's earlier history as the copy's too, to those who can see both",
      () =>
        Effect.gen(function* () {
          yield* seedCopy(true)
          yield* insertGrant({
            id: "source-grant",
            relayId: "relay-a",
            resourceId: "server-a",
            resourceType: "instance",
            userId: user.id,
          })
          yield* insertRows("access_selection", [
            {
              access_id: "source-grant",
              selection_key: "instance.read",
              selection_kind: "permission",
            },
          ])

          const result = yield* activityFor(user)

          assert.deepEqual(
            result.entries.map((entry) => ({
              id: entry.id,
              inheritedBy: entry.inheritedBy,
              target: entry.target?.id,
            })),
            [
              {
                id: "relay-a:server-a-event",
                inheritedBy: [{ instanceId: "server-copy", relayId: "relay-b" }],
                target: "server-a",
              },
            ]
          )
        })
    )

    it.effect(
      "marks a copied server's earlier history as the copy's too, for platform administrators",
      () =>
        Effect.gen(function* () {
          yield* seedCopy(true)

          const result = yield* activityFor({ ...user, role: "admin" })

          assert.deepEqual(
            result.entries
              .filter((entry) => entry.inheritedBy.length > 0)
              .map((entry) => ({
                id: entry.id,
                inheritedBy: entry.inheritedBy,
              })),
            [
              {
                id: "relay-a:server-a-event",
                inheritedBy: [{ instanceId: "server-copy", relayId: "relay-b" }],
              },
            ]
          )
          assert.notInclude(
            result.entries.map((entry) => entry.target?.id),
            "server-copy"
          )
        })
    )

    it.effect("shows the shared history once for each copy", () =>
      Effect.gen(function* () {
        yield* seedCopy(true)
        // A second copy of server-a, which the viewer can also see.
        yield* insertGrant({
          id: "second-copy-grant",
          relayId: "relay-b",
          resourceId: "server-copy-2",
          resourceType: "instance",
          userId: user.id,
        })
        yield* insertRows("access_selection", [
          {
            access_id: "second-copy-grant",
            selection_key: "instance.read",
            selection_kind: "permission",
          },
        ])
        yield* insertInstance("relay-b", "server-copy-2", {
          display_name: "server-copy-2",
        })
        yield* insertRows("server_migration", {
          actor: JSON.stringify(user),
          claim_generation: 1,
          create_key: randomUUID(),
          created_at: 1,
          destination_instance_id: "server-copy-2",
          destination_name: "server-copy-2",
          destination_relay_id: "relay-b",
          finished_at: 5,
          id: randomUUID(),
          mode: "duplicate",
          options: JSON.stringify({
            backup: null,
            copyAccess: false,
            keepActivity: true,
            moveDomain: false,
            moveWebRoutes: false,
            stopSource: false,
          }),
          requested_by: user.id,
          source_instance_id: "server-a",
          source_name: "server-a",
          source_relay_id: "relay-a",
          state: "completed",
          step: "finish",
          updated_at: 1,
        })

        const result = yield* activityFor(user)

        assert.sameMembers(
          result.entries.map((entry) => entry.target?.id),
          ["server-copy", "server-copy-2"]
        )
      })
    )

    it.effect(
      "keeps what happens to a copied server after the copy to itself",
      () =>
        Effect.gen(function* () {
          // server-a's event comes after its copy finished.
          yield* seedCopy(true, 0)

          const result = yield* activityFor(user)

          assert.deepEqual(result.entries, [])
        })
    )

    it.effect(
      "keeps a copy's earlier history to itself when it wasn't kept",
      () =>
        Effect.gen(function* () {
          yield* seedCopy(false)

          const result = yield* activityFor(user)

          assert.deepEqual(result.entries, [])
        })
    )

    it.effect("names the app or database an event acted on", () =>
      Effect.gen(function* () {
        yield* seed([])
        const appId = "a".repeat(40)
        const databaseId = "d".repeat(40)
        yield* insertRows("app", {
          app_id: appId,
          relay_id: "relay-a",
          name: "Bridge",
          config_ciphertext: "unused",
          created_by: "actor-a",
          created_at: 0,
          updated_at: 0,
        })
        yield* insertRows("database", {
          database_id: databaseId,
          relay_id: "relay-a",
          name: "Stats",
          engine: "postgres",
          database_name: "stats",
          username: "stats",
          password_ciphertext: "unused",
          created_by: "actor-a",
          created_at: 0,
          updated_at: 0,
        })
        relayRpc.mockImplementation(async (relay, operation) => {
          if (operation !== "relay.audit.list") {
            throw new Error("Snapshot unavailable")
          }
          if (relay.id !== "relay-a") return []
          // An app's files stand in for a game server's as `app:<id>`;
          // linking a database names both it and the game server.
          return [
            {
              id: "app-files",
              details: { instanceId: `app:${appId}`, operation: "files" },
              occurredAt: 2,
            },
            {
              id: "database-link",
              details: {
                databaseId,
                instanceId: "server-a",
                operation: "link",
              },
              occurredAt: 1,
            },
          ].map((record) => ({
            ...record,
            event: "control.mutation",
            clientId: null,
            requestId: null,
          }))
        })

        const result = yield* activityFor({ ...user, role: "admin" })

        assert.deepEqual(
          result.entries.map(({ databaseId, target }) => ({
            databaseId,
            target,
          })),
          [
            {
              databaseId: null,
              target: { id: appId, kind: "app", name: "Bridge" },
            },
            {
              databaseId,
              target: { id: "server-a", kind: "server", name: "server-a" },
            },
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
