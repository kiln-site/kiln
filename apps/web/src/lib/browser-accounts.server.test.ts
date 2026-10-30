import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { expect, vi } from "vite-plus/test"

import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
vi.stubEnv("KILN_URL", "http://localhost:3000")

const origin = "http://localhost:3000"
const password = "correct-horse-battery"

// A browser's cookie jar, filled by Better Auth's responses.
class Browser {
  readonly cookies = new Map<string, string>()

  headers(): Headers {
    return new Headers({
      cookie: [...this.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      origin,
    })
  }

  async request(
    path: string,
    init: { body?: unknown; headers?: HeadersInit; method?: string } = {}
  ) {
    const { auth } = await import("@/lib/auth")
    const headers = this.headers()
    for (const [name, value] of new Headers(init.headers))
      headers.set(name, value)
    if (init.body) headers.set("content-type", "application/json")
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
      })
    )
    this.store(response.headers)
    return response
  }

  store(headers: Headers) {
    for (const cookie of headers.getSetCookie()) {
      const [pair] = cookie.split(";")
      const index = pair.indexOf("=")
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      if (value && !/max-age=0/i.test(cookie)) this.cookies.set(name, value)
      else this.cookies.delete(name)
    }
  }

  signIn(email: string) {
    return this.request("/sign-in/email", {
      method: "POST",
      body: { email, password },
    })
  }
}

const seedAccount = (id: string) =>
  Effect.gen(function* () {
    const hash = yield* Effect.promise(async () => {
      const { auth } = await import("@/lib/auth")
      return (await auth.$context).password.hash(password)
    })
    const now = new Date()
    yield* insertUser(id, { manuallyVerifiedAt: now, status: "enabled" })
    yield* insertRows("account", {
      id: `credential-${id}`,
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hash,
      createdAt: now,
      updatedAt: now,
    })
  })

describeMysql("browser accounts", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps other accounts' sessions away from page scripts",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("alice@example.test"))
          yield* Effect.promise(() => browser.signIn("bob@example.test"))

          const listed = yield* Effect.promise(() =>
            browser.request("/multi-session/list-device-sessions")
          )
          expect(listed.status).toBe(404)
          const activated = yield* Effect.promise(() =>
            browser.request("/multi-session/set-active", {
              method: "POST",
              body: { sessionToken: "guess" },
            })
          )
          expect(activated.status).toBe(404)

          const { listBrowserAccounts } = yield* Effect.promise(
            () => import("@/lib/browser-accounts.server")
          )
          const accounts = yield* Effect.promise(() =>
            listBrowserAccounts(browser.headers())
          )
          expect(
            accounts.map(({ active, userId }) => ({ active, userId }))
          ).toEqual([
            { active: false, userId: "alice" },
            { active: true, userId: "bob" },
          ])
          expect(JSON.stringify(accounts)).not.toMatch(/token/i)
        }),
      { timeout: 30_000 }
    )

    it.effect(
      "switches only to accounts signed in on the same browser",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("mallory")
          const victim = new Browser()
          const attacker = new Browser()
          yield* Effect.promise(() => victim.signIn("alice@example.test"))
          yield* Effect.promise(() => attacker.signIn("mallory@example.test"))

          const { listBrowserAccounts, switchBrowserAccount } =
            yield* Effect.promise(() => import("@/lib/browser-accounts.server"))
          const [alice] = yield* Effect.promise(() =>
            listBrowserAccounts(victim.headers())
          )
          const error = yield* Effect.promise(() =>
            switchBrowserAccount(attacker.headers(), alice.sessionId).then(
              () => null,
              (cause: unknown) => cause
            )
          )
          expect(error).toBeInstanceOf(Error)
          const session = yield* Effect.promise(() =>
            attacker.request("/get-session").then((response) => response.json())
          )
          expect(session.user.id).toBe("mallory")
        }),
      { timeout: 30_000 }
    )

    it.effect(
      "refuses account changes from a tab rendering another account",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("alice@example.test"))
          // Another tab adds Bob, who becomes active for the whole browser.
          yield* Effect.promise(() => browser.signIn("bob@example.test"))

          const stale = yield* Effect.promise(() =>
            browser.request("/update-user", {
              method: "POST",
              headers: { "x-kiln-account": "alice" },
              body: { name: "Renamed" },
            })
          )
          expect(stale.status).toBe(409)
          const current = yield* Effect.promise(() =>
            browser.request("/update-user", {
              method: "POST",
              headers: { "x-kiln-account": "bob" },
              body: { name: "Robert" },
            })
          )
          expect(current.status).toBe(200)

          const users = yield* selectRows<{ id: string; name: string }>("user")
          expect(
            Object.fromEntries(users.map(({ id, name }) => [id, name]))
          ).toEqual({ alice: "alice", bob: "Robert" })
        }),
      { timeout: 30_000 }
    )
  })
})
