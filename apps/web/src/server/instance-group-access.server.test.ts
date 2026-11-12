import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  addInstanceGroupMemberEffect,
  createInstanceGroupEffect,
  instanceGroupOfEffect,
} from "@/effect/instance-groups"
import { createAppRecordEffect } from "@/effect/managed-apps"
import { createManagedDatabaseRecordEffect } from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { runOperation } from "@/operations/operation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// The account's password is the sign-in system's to check.
vi.mock("@/lib/auth-password", async () => {
  const { Effect } = await import("effect")
  return {
    requireAccountPasswordEffect: (_user: unknown, password: string) =>
      password === "correct"
        ? Effect.void
        : Effect.fail(new Error("That password isn't right")),
  }
})

import {
  deleteInstanceGroup,
  getInstanceGroupHandler,
  listInstanceGroupsHandler,
} from "./instance-group-access.server"

const relayId = "1".repeat(12)
const group = "9".repeat(12)
const app = "a".repeat(12)
const database = "d".repeat(12)

const person = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

// Bob's App and database, kept together; alice may do what she's granted.
const seed = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertUser("alice")
    yield* insertUser("bob")
    const grant = randomUUID()
    yield* insertGrant({
      id: grant,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      state: "active",
      userId: "alice",
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: grant,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
    yield* createAppRecordEffect({
      appId: app,
      createdBy: "bob",
      name: "Stats",
      relayId,
    })
    yield* createManagedDatabaseRecordEffect({
      brickId: "postgres",
      brickSource: "https://bricks.test/postgres.yml",
      createdBy: "bob",
      databaseId: database,
      databaseName: "kiln_main",
      engine: "postgres",
      internalPort: 5432,
      name: "Stats data",
      password: "the-password",
      relayId,
      username: "kiln_user",
    })
    yield* createInstanceGroupEffect({
      createdBy: "bob",
      id: group,
      name: "Stats",
    })
    yield* addInstanceGroupMemberEffect(group, {
      instanceId: app,
      kind: "app",
      relayId,
    })
    yield* addInstanceGroupMemberEffect(group, {
      instanceId: database,
      kind: "database",
      relayId,
    })
  })

const seen = (asked: { instanceId: string; kind: "app" | "database" }) =>
  Effect.promise(() =>
    getInstanceGroupHandler(person("alice"), { ...asked, relayId }).then(
      (found) => found,
      () => "refused" as const
    )
  )

const remove = (input: {
  confirmation?: string
  delete?: ReadonlyArray<string>
  password?: string
}) =>
  runOperation(
    deleteInstanceGroup,
    {
      confirmation: "Stats",
      delete: [],
      groupId: group,
      password: "correct",
      ...input,
    },
    { user: person("alice") }
  )

const members = Effect.map(instanceGroupOfEffect(app), (found) =>
  found ? found.members.map((member) => member.instanceId) : null
)

describeMysql("An instance group, to someone", () => {
  layer(TestDatabase)((it) => {
    it.effect("shows the members they may read, and no more", () =>
      Effect.gen(function* () {
        yield* seed(["app.read"])

        const found = yield* seen({ instanceId: app, kind: "app" })
        assert.isObject(found)
        if (found === "refused" || found === null) return
        assert.deepStrictEqual(
          found.members.map((member) => member.name),
          ["Stats"]
        )
        assert.strictEqual(found.hidden, 1)
        assert.isFalse(found.canDelete)

        // Not through a member they can't read, whatever kind they call it.
        assert.strictEqual(
          yield* seen({ instanceId: database, kind: "database" }),
          "refused"
        )
        assert.isNull(yield* seen({ instanceId: database, kind: "app" }))

        // Listed with the rest the same way: the members they may read.
        const listed = Effect.promise(() =>
          listInstanceGroupsHandler(person("alice"))
        )
        // It says it holds more than they see, so choosing it for what it
        // keeps never passes for choosing all of it.
        assert.deepStrictEqual(
          (yield* listed).map(({ hidden, members, name }) => [
            name,
            members.map((member) => member.instanceId),
            hidden,
          ]),
          [["Stats", [app], 1]]
        )
        // A group none of whose members they may read isn't listed at all.
        yield* seed([])
        assert.deepStrictEqual(yield* listed, [])
      })
    )

    it.effect(
      "is deleted only by someone who may delete every member, who names it",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.read", "app.delete", "database.read"])
          yield* remove({}).pipe(Effect.flip)
          assert.deepStrictEqual(yield* members, [app, database])

          yield* seed(["app.delete", "database.delete"])
          yield* remove({ confirmation: "Statistics" }).pipe(Effect.flip)
          yield* remove({ password: "guess" }).pipe(Effect.flip)
          assert.deepStrictEqual(yield* members, [app, database])

          // Forgotten, with every member kept: they stay, in no group.
          yield* remove({})
          assert.isNull(yield* members)
          assert.strictEqual((yield* selectRows("app")).length, 1)
          assert.strictEqual((yield* selectRows("database")).length, 1)
        })
    )
  })
})
