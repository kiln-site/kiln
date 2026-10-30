import { assert, layer } from "@effect/vitest"
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
import { requireRelayPermissionsEffect } from "@/lib/access-control"

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
