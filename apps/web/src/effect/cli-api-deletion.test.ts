import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { deleteCliServerEffect } from "@/effect/cli-api"
import { CliAccessError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql } from "@/test/database"
import {
  deletionRelay as relay,
  owner,
  relayId,
  seedDeletion,
  serverId,
} from "@/test/resource-deletion"
import { insertRows, selectRows } from "@/test/seed"

// The Relay (test/resource-deletion.ts) and Better Auth's password verifier
// are the fakes.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  ...(await import("@/test/resource-deletion")).deletionRelayConnection,
}))
vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: {
        verify: async (input: { hash: string; password: string }) =>
          input.hash === `hashed:${input.password}`,
      },
    }),
  },
}))

afterAll(() => disposeAppRuntime())

const principal = {
  credentialId: "cli-credential",
  mode: "full_access" as const,
  user: owner,
}

// The owner's game server, which the Relay calls Survival, and their
// password.
const seed = Effect.gen(function* () {
  yield* seedDeletion
  yield* insertRows("account", {
    accountId: owner.id,
    createdAt: new Date(0),
    id: "credential",
    password: "hashed:correct horse battery",
    providerId: "credential",
    updatedAt: new Date(0),
    userId: owner.id,
  })
})

const deleteServer = (input: Record<string, unknown>) =>
  Effect.flip(
    deleteCliServerEffect(principal, {
      instanceId: serverId,
      relayId,
      ...input,
    })
  )

describeMysql("Deleting a game server from the CLI", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "refuses without the server's name and the account password, starting nothing",
      () =>
        Effect.gen(function* () {
          yield* seed

          const unconfirmed = yield* deleteServer({})
          const misnamed = yield* deleteServer({
            confirmation: `${relayId}:${serverId}`,
            password: "correct horse battery",
          })
          const wrongPassword = yield* deleteServer({
            confirmation: "Survival",
            password: "wrong",
          })

          assert.instanceOf(unconfirmed, CliAccessError)
          for (const refused of [misnamed, wrongPassword]) {
            assert.instanceOf(refused, CliAccessError)
            assert.strictEqual(refused.code, "forbidden")
          }
          assert.deepStrictEqual(relay.changes, [])
          assert.lengthOf(yield* selectRows("resource_deletion"), 0)
        }),
      60_000
    )
  })
})
