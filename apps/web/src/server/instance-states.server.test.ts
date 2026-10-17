import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { InstanceStateResult } from "@workspace/contracts"

import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  InstanceStateSource,
  readInstanceStates,
} from "@/server/instance-states.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

const relayId = "r".repeat(43)
const id = "a".repeat(40)
const user: AuthenticatedUser = {
  id: "reader",
  name: "Reader",
  email: "reader@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

describeMysql("instance status authorization", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "only exposes the resource kind, ID, and Relay allowed by a scoped grant",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser(user.id)
          yield* insertRelay(relayId)
          yield* insertRelay("s".repeat(43))
          yield* insertGrant({
            id: "grant",
            userId: user.id,
            relayId,
            resourceType: "instance",
            resourceId: id,
          })
          yield* insertRows("access_selection", {
            access_id: "grant",
            selection_kind: "permission",
            selection_key: "instance.read",
          })
          const results = yield* readInstanceStates(user, [
            { kind: "server", relayId, id },
            { kind: "server", relayId, id: "b".repeat(40) },
            { kind: "server", relayId: "s".repeat(43), id },
            { kind: "database", relayId, id },
            { kind: "app", relayId, id },
            { kind: "relay", relayId, id: relayId },
          ]).pipe(
            Effect.provideService(InstanceStateSource, {
              read: (_, references) =>
                Effect.succeed(
                  references.map((reference): InstanceStateResult => ({
                    reference,
                    observation: {
                      ...reference,
                      reachability: "connected",
                      runtime: "running",
                      inventory: "available",
                      updating: false,
                    },
                  }))
                ),
            })
          )
          assert.deepStrictEqual(
            results
              .filter((result) => "observation" in result)
              .map((result) => result.reference),
            [{ kind: "server", relayId, id }]
          )
          assert.strictEqual(
            results.filter((result) => "error" in result).length,
            5
          )
        })
    )
  })
})
