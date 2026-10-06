import { assert, describe, it, layer } from "@effect/vitest"
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
  allowedInstanceIdsForUser,
  canReadRelayNode,
  type AccessGrant,
  isPlatformAdmin,
  isRelayCreator,
  requireRelayPermissionsEffect,
  visibleRelaysForUser,
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

describe("platform access roles", () => {
  it("keeps Relay creators distinct from platform administrators", () => {
    const relayCreator = {
      ...authenticatedUser,
      role: "relay_creator",
    } satisfies AuthenticatedUser
    const platformAdmin = {
      ...authenticatedUser,
      role: "admin",
    } satisfies AuthenticatedUser

    assert.isTrue(isRelayCreator(relayCreator))
    assert.isFalse(isPlatformAdmin(relayCreator))
    assert.isTrue(isPlatformAdmin(platformAdmin))
    assert.isFalse(isRelayCreator(platformAdmin))
  })

  it("exposes only created or granted Relays outside platform administration", () => {
    const relays = [
      { createdBy: "creator", id: "owned" },
      { createdBy: "someone-else", id: "granted" },
      { createdBy: "someone-else", id: "private" },
    ]
    const creator = {
      ...authenticatedUser,
      id: "creator",
      role: "relay_creator",
    } satisfies AuthenticatedUser

    // Relay creators appear in grants as owner rows, so creation alone does
    // not widen visibility.
    assert.deepEqual(
      visibleRelaysForUser(creator, relays, [
        { relayId: "owned" },
        { relayId: "granted" },
      ]).map((relay) => relay.id),
      ["owned", "granted"]
    )
    assert.deepEqual(
      visibleRelaysForUser(creator, relays, []).map((relay) => relay.id),
      []
    )
    assert.deepEqual(
      visibleRelaysForUser(authenticatedUser, relays, [
        { relayId: "granted" },
      ]).map((relay) => relay.id),
      ["granted"]
    )
    assert.deepEqual(
      visibleRelaysForUser(
        { ...authenticatedUser, role: "admin" },
        relays,
        []
      ).map((relay) => relay.id),
      ["owned", "granted", "private"]
    )
  })
})

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

    it.effect("requires every requested permission", () =>
      Effect.gen(function* () {
        yield* seedConsoleGrant("instance.console.read")
        assert.strictEqual(
          yield* denied({
            instanceId: "instance-one",
            permissions: ["instance.console.read", "instance.console.write"],
            relayId: "relay-one",
            user: authenticatedUser,
          }),
          "PermissionDeniedError"
        )
      })
    )

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

    it.effect("grants a Relay creator authority over its children", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one", { created_by: authenticatedUser.id })
        yield* requireRelayPermissionsEffect({
          instanceId: "instance-one",
          permissions: ["relay.read", "instance.delete"],
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

describe("Relay snapshot visibility", () => {
  const relayId = "relay-one"
  const instances = ["instance-one", "instance-two"]
  const instanceGrant: AccessGrant = {
    id: "instance-grant",
    relayId,
    resourceId: "instance-one",
    resourceType: "instance",
    permissions: ["instance.read"],
  }
  const databaseGrant: AccessGrant = {
    ...instanceGrant,
    id: "database-grant",
    resourceId: "database-one",
    resourceType: "database",
    permissions: ["database.read"],
  }
  const relayInstancesGrant: AccessGrant = {
    ...instanceGrant,
    id: "relay-instances-grant",
    resourceId: relayId,
    resourceType: "relay",
  }
  const relayNodeGrant: AccessGrant = {
    ...relayInstancesGrant,
    id: "relay-node-grant",
    permissions: ["relay.read"],
  }

  it("keeps child inventory accessible without exposing Relay nodes", () => {
    for (const [grants, expectedInstances] of [
      [[instanceGrant], ["instance-one"]],
      [[databaseGrant], []],
      [[relayInstancesGrant], instances],
      [[instanceGrant, databaseGrant], ["instance-one"]],
    ] satisfies Array<[Array<AccessGrant>, Array<string>]>) {
      assert.isFalse(canReadRelayNode(authenticatedUser, relayId, grants))
      assert.deepEqual(
        [
          ...allowedInstanceIdsForUser(
            authenticatedUser,
            relayId,
            instances,
            grants
          ),
        ],
        expectedInstances
      )
    }
  })

  it("requires relay.read on this Relay independently of instance access", () => {
    assert.isTrue(
      canReadRelayNode(authenticatedUser, relayId, [relayNodeGrant])
    )
    assert.deepEqual(
      [
        ...allowedInstanceIdsForUser(authenticatedUser, relayId, instances, [
          relayNodeGrant,
        ]),
      ],
      []
    )
    assert.isTrue(
      canReadRelayNode(authenticatedUser, relayId, [
        instanceGrant,
        relayNodeGrant,
      ])
    )
    assert.deepEqual(
      [
        ...allowedInstanceIdsForUser(authenticatedUser, relayId, instances, [
          instanceGrant,
          relayNodeGrant,
        ]),
      ],
      ["instance-one"]
    )
    assert.isFalse(
      canReadRelayNode(authenticatedUser, relayId, [
        { ...relayNodeGrant, relayId: "other-relay" },
      ])
    )
    // Even malformed child grants cannot authorize parent infrastructure.
    assert.isFalse(
      canReadRelayNode(authenticatedUser, relayId, [
        { ...instanceGrant, permissions: ["relay.read"] },
      ])
    )
  })

  it("allows platform admins and development bypass while rejecting disabled users", () => {
    for (const user of [
      { ...authenticatedUser, role: "admin" as const },
      { ...authenticatedUser, isDevelopmentBypass: true },
    ]) {
      assert.isTrue(canReadRelayNode(user, relayId, []))
      assert.deepEqual(
        [...allowedInstanceIdsForUser(user, relayId, instances, [])],
        instances
      )
    }
    assert.isFalse(
      canReadRelayNode({ ...authenticatedUser, status: "disabled" }, relayId, [
        relayNodeGrant,
      ])
    )
    assert.isFalse(
      canReadRelayNode(
        { ...authenticatedUser, role: "relay_creator" },
        relayId,
        []
      )
    )
  })
})
