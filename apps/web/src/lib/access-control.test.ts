import { assert, layer } from "@effect/vitest"
import {
  appFileRootId,
  appVolumeFileRootId,
  databaseFileRootId,
  relayFileRootId,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
} from "@/test/seed"
import {
  requireFileRootPermissionEffect,
  requireRelayPermissionsEffect,
} from "@/lib/access-control"

const authenticatedUser = {
  email: "user@example.com",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "user-one",
  isDevelopmentBypass: false,
  name: "User",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

describeMysql("Relay permission requirements", () => {
  layer(TestDatabase)((it) => {
    const denied = (
      input: Parameters<typeof requireRelayPermissionsEffect>[0]
    ) =>
      requireRelayPermissionsEffect(input).pipe(
        Effect.flip,
        Effect.map((error) => error._tag)
      )

    const seedConsoleGrant = (key: string) =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertGrant({
          id: "grant-one",
          userId: authenticatedUser.id,
          relayId: "relay-one",
          resourceType: "instance",
          resourceId: "instance-one",
        })
        yield* insertRows("access_selection", {
          access_id: "grant-one",
          selection_kind: "permission",
          selection_key: key,
        })
      })

    it.effect(
      "allows implied permissions only on the granted Relay and instance",
      () =>
        Effect.gen(function* () {
          yield* seedConsoleGrant("instance.console.write")
          yield* requireRelayPermissionsEffect({
            instanceId: "instance-one",
            permissions: ["instance.console.read", "instance.console.write"],
            relayId: "relay-one",
            user: authenticatedUser,
          })
          for (const target of [
            { instanceId: "instance-two", relayId: "relay-one" },
            { instanceId: "instance-one", relayId: "relay-two" },
          ]) {
            assert.strictEqual(
              yield* denied({
                ...target,
                permissions: ["instance.console.read"],
                user: authenticatedUser,
              }),
              "PermissionDeniedError"
            )
          }
        })
    )

    it.effect("never derives relay.read from child grants", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertInstance("relay-one", "owned", {
          owner_id: authenticatedUser.id,
        })
        yield* insertGrant({
          id: "grant-one",
          userId: authenticatedUser.id,
          relayId: "relay-one",
          resourceType: "instance",
          resourceId: "instance-one",
        })
        yield* insertRows("access_selection", {
          access_id: "grant-one",
          selection_kind: "collection",
          selection_key: "all",
        })
        assert.strictEqual(
          yield* denied({
            permissions: ["relay.read"],
            relayId: "relay-one",
            user: authenticatedUser,
          }),
          "PermissionDeniedError"
        )

        yield* insertGrant({
          id: "relay-grant",
          userId: authenticatedUser.id,
          relayId: "relay-one",
          resourceType: "relay",
          resourceId: "relay-one",
        })
        yield* insertRows("access_selection", {
          access_id: "relay-grant",
          selection_kind: "permission",
          selection_key: "relay.read",
        })
        yield* requireRelayPermissionsEffect({
          permissions: ["relay.read"],
          relayId: "relay-one",
          user: authenticatedUser,
        })
      })
    )

    it.effect(
      "a file root's files take the permissions of what they belong to",
      () =>
        Effect.gen(function* () {
          const relayId = "1".repeat(12)
          const appId = "a".repeat(12)
          const roots = {
            server: "5".repeat(12),
            app: appFileRootId(appId),
            volume: appVolumeFileRootId(appId, "c".repeat(40)),
            dumps: databaseFileRootId("d".repeat(12)),
            host: relayFileRootId(relayId),
          }
          // What a person holding one permission can do under each root:
          // on the whole Relay, or on one game server.
          const reach = (permission: AccessPermission, serverId?: string) =>
            Effect.gen(function* () {
              yield* resetDatabase
              yield* insertRelay(relayId)
              yield* insertGrant({
                id: "grant-one",
                userId: authenticatedUser.id,
                relayId,
                resourceType: serverId ? "instance" : "relay",
                resourceId: serverId ?? relayId,
              })
              yield* insertRows("access_selection", {
                access_id: "grant-one",
                selection_kind: "permission",
                selection_key: permission,
              })
              const allowed: Array<string> = []
              for (const [name, rootId] of Object.entries(roots)) {
                for (const access of ["read", "write", "delete"] as const) {
                  const result = yield* Effect.exit(
                    requireFileRootPermissionEffect(
                      authenticatedUser,
                      relayId,
                      rootId,
                      access
                    )
                  )
                  if (result._tag === "Success")
                    allowed.push(`${name} ${access}`)
                }
              }
              return allowed
            })

          // On a Relay, a file permission covers every game server's and
          // App's files, and nothing else's.
          assert.deepStrictEqual(yield* reach("instance.files.read"), [
            "server read",
            "app read",
            "volume read",
          ])
          assert.deepStrictEqual(yield* reach("instance.files.write"), [
            "server read",
            "server write",
            "app read",
            "app write",
            "volume read",
            "volume write",
          ])
          assert.deepStrictEqual(yield* reach("instance.files.delete"), [
            "server read",
            "server delete",
            "app read",
            "app delete",
            "volume read",
            "volume delete",
          ])
          // What only Apps have stops short of their files.
          assert.deepStrictEqual(yield* reach("app.manage"), [])
          // Given on one game server, it stays there: not an App's files,
          // and not another game server's.
          assert.deepStrictEqual(
            yield* reach("instance.files.write", roots.server),
            ["server read", "server write"]
          )
          assert.deepStrictEqual(
            yield* reach("instance.files.write", "6".repeat(12)),
            []
          )
          assert.deepStrictEqual(yield* reach("database.dump.export"), [
            "dumps read",
          ])
          assert.deepStrictEqual(yield* reach("database.dump.import"), [
            "dumps write",
            "dumps delete",
          ])
          assert.deepStrictEqual(yield* reach("relay.files.write"), [
            "host read",
            "host write",
            "host delete",
          ])

          // Another Relay's host files aren't this Relay's to give, whatever
          // the person holds here.
          assert.strictEqual(
            yield* requireFileRootPermissionEffect(
              authenticatedUser,
              relayId,
              relayFileRootId("2".repeat(12)),
              "read"
            ).pipe(
              Effect.flip,
              Effect.map((error) => error._tag)
            ),
            "ResourceNotFoundError"
          )
        })
    )

    it.effect("denies disabled, unverified, or empty requests", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one", { created_by: authenticatedUser.id })
        for (const [user, permissions] of [
          [authenticatedUser, []],
          [{ ...authenticatedUser, status: "disabled" }, ["relay.read"]],
          [{ ...authenticatedUser, emailVerifiedAt: null }, ["relay.read"]],
        ] satisfies Array<[AuthenticatedUser, Array<AccessPermission>]>) {
          assert.strictEqual(
            yield* denied({ permissions, relayId: "relay-one", user }),
            "PermissionDeniedError"
          )
        }
      })
    )
  })
})
