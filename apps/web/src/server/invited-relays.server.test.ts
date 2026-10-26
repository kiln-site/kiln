import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { listInvitedRelaysEffect } from "@/server/invited-relays.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

const now = Date.UTC(2026, 5, 1)

const invite = Effect.fnUntraced(function* (input: {
  readonly grantState?: "pending" | "revoked"
  readonly relayId: string
  readonly resourceType?: "relay" | "instance"
  readonly userId?: string
  readonly invitation?: Record<string, number | string>
}) {
  const accessId = randomUUID()
  const resourceType = input.resourceType ?? "relay"
  const userId = input.userId ?? "invitee"
  yield* insertGrant({
    id: accessId,
    relayId: input.relayId,
    resourceId: resourceType === "relay" ? input.relayId : "server-1",
    resourceType,
    role: "viewer",
    state: input.grantState ?? "pending",
    userId,
  })
  yield* insertRows("invitation", {
    id: randomUUID(),
    token_hash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    email: `${userId}@example.test`,
    access_id: accessId,
    user_id: userId,
    access_type: "scoped",
    relay_id: input.relayId,
    role: "viewer",
    invited_by: "owner",
    expires_at: now + 86_400_000,
    created_at: now - 1_000,
    ...input.invitation,
  })
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
  yield* insertUser("owner", {
    email: "owner.private@example.test",
    name: "Notch",
  })
  yield* insertUser("invitee")
  yield* insertUser("someone-else")
  for (const id of [
    "relay-invited",
    "relay-accepted",
    "relay-declined",
    "relay-expired",
    "relay-cancelled",
    "relay-revoked",
    "relay-grant-revoked",
    "relay-disabled",
    "relay-server-only",
    "relay-not-mine",
  ]) {
    yield* insertRelay(id, {
      created_by: "owner",
      enabled: id !== "relay-disabled",
      port: 8443,
      use_tls: true,
    })
  }
  yield* invite({ relayId: "relay-invited" })
  yield* invite({
    relayId: "relay-accepted",
    invitation: { accepted_at: now - 500 },
  })
  yield* invite({
    relayId: "relay-declined",
    invitation: { declined_at: now - 500 },
  })
  yield* invite({
    relayId: "relay-expired",
    invitation: { expires_at: now - 1 },
  })
  // Cancelling sets revoked_at too; either alone must hide the invitation.
  yield* invite({
    relayId: "relay-cancelled",
    invitation: { cancelled_at: now - 500 },
  })
  yield* invite({
    relayId: "relay-revoked",
    invitation: { revoked_at: now - 500 },
  })
  yield* invite({ relayId: "relay-grant-revoked", grantState: "revoked" })
  yield* invite({ relayId: "relay-disabled" })
  yield* invite({ relayId: "relay-server-only", resourceType: "instance" })
  yield* invite({ relayId: "relay-not-mine", userId: "someone-else" })
})

describeMysql("Invited Relays", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "shows only Relays the user is invited to and hasn't answered",
      () =>
        Effect.gen(function* () {
          yield* seed

          const relays = yield* listInvitedRelaysEffect("invitee", true)

          assert.deepStrictEqual(relays, [
            {
              createdBy: "owner",
              hostname: "relay-invited.relay.test",
              id: "relay-invited",
              memory: undefined,
              ownerEmail: "owner.private@example.test",
              ownerName: "Notch",
              port: 8443,
              useTls: true,
            },
          ])
        })
    )

    it.effect("names owners from their email only with owner details", () =>
      Effect.gen(function* () {
        yield* seed
        yield* insertUser("unnamed-owner", {
          email: "unnamed.private@example.test",
          name: "",
        })
        yield* insertRelay("relay-unnamed-owner", {
          created_by: "unnamed-owner",
        })
        yield* invite({ relayId: "relay-unnamed-owner" })

        // Without details, as for Mojang lookups, no email or name derived
        // from one appears.
        assert.notInclude(
          JSON.stringify(yield* listInvitedRelaysEffect("invitee", false)),
          "private"
        )
        const unnamed = (yield* listInvitedRelaysEffect("invitee", true)).find(
          (relay) => relay.id === "relay-unnamed-owner"
        )
        assert.strictEqual(unnamed?.ownerEmail, "unnamed.private@example.test")
      })
    )
  })
})
