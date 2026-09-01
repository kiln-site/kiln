import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  accessGrantRoleChangeError,
  deduplicateEffectiveInstanceGrants,
  deleteInstanceAccessEffect,
  isBlockedInstanceOwnerRoleChange,
  isCurrentInstanceOwnerGrant,
  isPlatformAdmin,
  isProtectedInstanceOwnerGrant,
  isRelayCreator,
  requireRelayPermissionsEffect,
  visibleRelaysForUser,
} from "@/lib/access-control"

const authenticatedUser = {
  email: "user@example.com",
  emailVerified: true,
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

    assert.deepEqual(
      visibleRelaysForUser(creator, relays, [{ relayId: "granted" }]).map(
        (relay) => relay.id
      ),
      ["owned", "granted"]
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
  it.effect("loads grants once and requires every requested permission", () => {
    let queryCount = 0
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: <TRow extends RowDataPacket>() =>
        Effect.sync(() => {
          queryCount += 1
          return [
            {
              id: "grant-one",
              relay_id: "relay-one",
              resource_type: "instance",
              resource_id: "instance-one",
              role: "viewer",
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
      assert.strictEqual(queryCount, 1)
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("allows every requested permission from one grant query", () => {
    let queryCount = 0
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: <TRow extends RowDataPacket>() =>
        Effect.sync(() => {
          queryCount += 1
          return [
            {
              id: "grant-one",
              relay_id: "relay-one",
              resource_type: "instance",
              resource_id: "instance-one",
              role: "operator",
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

      assert.strictEqual(queryCount, 1)
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

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

describe("instance access cleanup", () => {
  it("shows each user once and prefers a direct instance grant", () => {
    const grants: Array<{
      id: string
      resourceType: "instance" | "relay"
      userId: string
    }> = [
      {
        id: "direct-one",
        resourceType: "instance",
        userId: "user-one",
      },
      {
        id: "relay-two",
        resourceType: "relay",
        userId: "user-two",
      },
      {
        id: "relay-one",
        resourceType: "relay",
        userId: "user-one",
      },
      {
        id: "direct-two",
        resourceType: "instance",
        userId: "user-two",
      },
      {
        id: "relay-three",
        resourceType: "relay",
        userId: "user-three",
      },
    ]
    assert.deepEqual(deduplicateEffectiveInstanceGrants(grants), [
      {
        id: "direct-one",
        resourceType: "instance",
        userId: "user-one",
      },
      {
        id: "direct-two",
        resourceType: "instance",
        userId: "user-two",
      },
      {
        id: "relay-three",
        resourceType: "relay",
        userId: "user-three",
      },
    ])
  })

  it("protects the current owner and any remaining owner-role grant", () => {
    assert.isTrue(
      isCurrentInstanceOwnerGrant({
        grantUserId: "owner-one",
        ownerId: "owner-one",
      })
    )
    assert.isTrue(
      isProtectedInstanceOwnerGrant({
        grantRole: "admin",
        grantUserId: "owner-one",
        ownerId: "owner-one",
      })
    )
    assert.isTrue(
      isProtectedInstanceOwnerGrant({
        grantRole: "owner",
        grantUserId: "owner-two",
        ownerId: null,
      })
    )
    assert.isFalse(
      isProtectedInstanceOwnerGrant({
        grantRole: "admin",
        grantUserId: "member-one",
        ownerId: "owner-one",
      })
    )
  })

  it("only allows the persisted owner's grant to retain or regain owner", () => {
    assert.isTrue(
      isBlockedInstanceOwnerRoleChange({
        grantRole: "admin",
        grantUserId: "owner-one",
        nextRole: "viewer",
        ownerId: "owner-one",
      })
    )
    assert.isFalse(
      isBlockedInstanceOwnerRoleChange({
        grantRole: "admin",
        grantUserId: "owner-one",
        nextRole: "owner",
        ownerId: "owner-one",
      })
    )
    assert.isFalse(
      isBlockedInstanceOwnerRoleChange({
        grantRole: "owner",
        grantUserId: "former-owner",
        nextRole: "admin",
        ownerId: "owner-one",
      })
    )
    assert.isFalse(
      isBlockedInstanceOwnerRoleChange({
        grantRole: "admin",
        grantUserId: "owner-one",
        nextRole: "admin",
        ownerId: "owner-one",
      })
    )
  })

  it("applies owner protections when Add User targets an existing account", () => {
    assert.strictEqual(
      accessGrantRoleChangeError({
        canManageOwners: false,
        currentRole: "owner",
        nextRole: "operator",
        ownerId: null,
        userId: "relay-owner",
      })?.message,
      "Only a Relay owner or platform admin can change owner access"
    )
    assert.strictEqual(
      accessGrantRoleChangeError({
        canManageOwners: true,
        currentRole: null,
        nextRole: "viewer",
        ownerId: "instance-owner",
        userId: "instance-owner",
      })?.message,
      "Transfer ownership before changing the server owner's role"
    )
    assert.isNull(
      accessGrantRoleChangeError({
        canManageOwners: false,
        currentRole: "operator",
        nextRole: "viewer",
        ownerId: null,
        userId: "member-one",
      })
    )
  })

  it.effect("removes grants and pending invitations in one transaction", () => {
    const statements: Array<{
      sql: string
      values: ReadonlyArray<unknown>
    }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              statements.push({ sql, values: values ?? [] })
              return emptyResult
            }),
          queryRows: () => Effect.succeed([]),
        }),
    })

    return Effect.gen(function* () {
      yield* deleteInstanceAccessEffect("relay-one", "instance-one")

      assert.strictEqual(statements.length, 2)
      assert.include(statements[0]?.sql, "resource_type = 'instance'")
      assert.deepEqual(statements[0]?.values, ["relay-one", "instance-one"])
      assert.include(statements[1]?.sql, "accepted_at IS NULL")
      assert.include(statements[1]?.sql, "revoked_at IS NULL")
      assert.include(statements[1]?.sql, "expires_at > CURRENT_TIMESTAMP(3)")
      assert.deepEqual(statements[1]?.values, ["relay-one", "instance-one"])
    }).pipe(Effect.provide(databaseLayer))
  })
})
