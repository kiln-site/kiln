import { createHmac } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  createServerEntry,
  getResponseHeaders,
  setCookie,
} from "@tanstack/react-start/server"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vite-plus/test"

import { auth } from "@/lib/auth"
import { databaseTableName } from "@/lib/database-config"
import {
  publishRealtimeChange,
  type RealtimeSourceChange,
} from "@/lib/realtime-source.server"
import { Route } from "@/routes/api.account-status"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

// Better Auth reads its keyring when `@/lib/auth` is imported.
vi.hoisted(() => {
  vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
})

const day = 24 * 60 * 60 * 1_000
const token = "target-session-token"

// The browser cookie for a session, signed as Better Auth signs its own.
const sessionCookie = Effect.promise(() => auth.$context).pipe(
  Effect.map(({ authCookies, secret }) => {
    const signature = createHmac("sha256", secret).update(token).digest("base64")
    const value = encodeURIComponent(`${token}.${signature}`)
    return {
      header: `${authCookies.sessionToken.name}=${value}`,
      name: authCookies.sessionToken.name,
    }
  })
)

// A live /api/account-status stream, opened by the target's own request.
const openStatusStream = (cookie: string) =>
  Effect.promise(async () => {
    const request = new Request("http://hearth.test/api/account-status", {
      headers: { cookie },
    })
    const handlers = Route.options.server?.handlers as {
      GET: (context: { request: Request }) => Promise<Response>
    }
    const response = await createServerEntry({
      fetch: (request) => handlers.GET({ request }),
    }).fetch(request)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("The status stream has no body")
    await reader.read()
    return reader
  })

// Another user's request publishing a change, held open until the stream has
// finished reacting. The race is real without the hold: a response that left
// first would simply look clean.
const publishFromAnotherRequest = (
  change: RealtimeSourceChange,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  before: () => void = () => {}
) =>
  Effect.promise(async () => {
    let cookies: ReadonlyArray<string> = []
    await createServerEntry({
      fetch: async () => {
        before()
        publishRealtimeChange(change)
        await reader.read()
        cookies = getResponseHeaders().getSetCookie()
        return new Response(null)
      },
    }).fetch(new Request("http://hearth.test/_serverFn/publisher"))
    return cookies
  })

const seedTarget = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("target")
  yield* insertRows("session", {
    id: "target-session",
    token,
    userId: "target",
    expiresAt: new Date(Date.now() + 7 * day),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
})

describeMysql("realtime request isolation", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps a refreshed session off the publisher's response", () =>
      Effect.gen(function* () {
        yield* seedTarget
        const cookie = yield* sessionCookie
        const reader = yield* openStatusStream(cookie.header)

        // The stream's own first lookup renewed the session; make it due again
        // so the lookup a change triggers refreshes it.
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE ${sql(databaseTableName("session"))}
          SET expiresAt = ${new Date(Date.now() + 5 * day)}
          WHERE id = 'target-session'
        `

        const cookies = yield* publishFromAnotherRequest(
          { reauthenticate: false, type: "access.changed", userIds: ["target"] },
          reader
        )

        assert.deepStrictEqual(cookies, [])
        yield* Effect.promise(() => reader.cancel())
      })
    )

    it.effect("keeps a dead session's cleanup off the publisher's cookie", () =>
      Effect.gen(function* () {
        yield* seedTarget
        const cookie = yield* sessionCookie
        const reader = yield* openStatusStream(cookie.header)

        const sql = yield* SqlClient.SqlClient
        yield* sql`
          DELETE FROM ${sql(databaseTableName("session"))}
          WHERE id = 'target-session'
        `

        // As a session rotation does: the response carries the new session
        // while the stream, on the old cookie, finds its session gone.
        const cookies = yield* publishFromAnotherRequest(
          { sessionIds: ["target-session"], type: "session.revoked" },
          reader,
          () => setCookie(cookie.name, "rotated-session", { path: "/" })
        )

        assert.strictEqual(cookies.length, 1)
        assert.match(cookies[0] ?? "", /rotated-session/)
        yield* Effect.promise(() => reader.cancel())
      })
    )
  })
})
