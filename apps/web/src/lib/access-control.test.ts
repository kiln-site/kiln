import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
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

describe("Relay permission requirements", () => {
  it.effect(
    "loads one bounded grant batch and requires every requested permission",
    () => {
      let queryCount = 0
      const databaseLayer = Layer.succeed(Database)({
        execute: () => Effect.die("Unexpected database write"),
        queryRows: <TRow extends RowDataPacket>() =>
          Effect.sync(() => {
            queryCount += 1
            if (queryCount === 2)
              return [
                {
                  access_id: "grant-one",
                  selection_kind: "permission",
                  selection_key: "instance.console.read",
                },
              ] as unknown as ReadonlyArray<TRow>
            if (queryCount === 3) return []
            return [
              {
                id: "grant-one",
                relay_id: "relay-one",
                resource_type: "instance",
                resource_id: "instance-one",
              },
            ] as unknown as ReadonlyArray<TRow>
          }),
        transaction: () => Effect.die("Unexpected transaction"),
      })

      return Effect.gen(function* () {
        const result = yield* Effect.result(
          requireRelayPermissionsEffect({
            instanceId: "instance-one",
            permissions: ["instance.console.read", "instance.console.write"],
            relayId: "relay-one",
            user: authenticatedUser,
          })
        )

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "PermissionDeniedError")
        }
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect("allows implied permissions from one bounded grant batch", () => {
    let queryCount = 0
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: <TRow extends RowDataPacket>() =>
        Effect.sync(() => {
          queryCount += 1
          if (queryCount === 2)
            return [
              {
                access_id: "grant-one",
                selection_kind: "permission",
                selection_key: "instance.console.write",
              },
            ] as unknown as ReadonlyArray<TRow>
          if (queryCount === 3) return []
          return [
            {
              id: "grant-one",
              relay_id: "relay-one",
              resource_type: "instance",
              resource_id: "instance-one",
            },
          ] as unknown as ReadonlyArray<TRow>
        }),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    return Effect.gen(function* () {
      yield* requireRelayPermissionsEffect({
        instanceId: "instance-one",
        permissions: ["instance.console.read", "instance.console.write"],
        relayId: "relay-one",
        user: authenticatedUser,
      })
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("fails closed when no permissions are requested", () => {
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: () => Effect.die("Unexpected grant query"),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        requireRelayPermissionsEffect({
          permissions: [],
          relayId: "relay-one",
          user: authenticatedUser,
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PermissionDeniedError")
      }
    }).pipe(Effect.provide(databaseLayer))
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
