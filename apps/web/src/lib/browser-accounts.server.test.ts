import { layer } from "@effect/vitest"
import { requestHandler } from "@tanstack/react-start/server"
import { Effect } from "effect"
import { expect, vi } from "vite-plus/test"

import type { BrowserAccount } from "@/lib/browser-accounts"
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

  async listAccounts(): Promise<
    Array<Omit<BrowserAccount, "minecraftProfileId">>
  > {
    const { listBrowserAccounts } =
      await import("@/lib/browser-accounts.server")
    const handler = requestHandler(async (request) =>
      Response.json(await listBrowserAccounts(request.headers))
    )
    const response = await handler(
      new Request(`${origin}/accounts`, { headers: this.headers() }),
      {}
    )
    this.store(response.headers)
    return response.json()
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
      "keeps account order across switches, renames, and session replacements",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          yield* seedAccount("charlie")
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("charlie@example.test"))
          yield* Effect.promise(() => browser.signIn("alice@example.test"))
          yield* Effect.promise(() => browser.signIn("bob@example.test"))

          const { auth } = yield* Effect.promise(() => import("@/lib/auth"))
          const accounts = yield* Effect.promise(() => browser.listAccounts())
          const order = accounts.map(({ userId }) => userId)
          expect(order).toEqual(["alice", "bob", "charlie"])

          const renamed = yield* Effect.promise(() =>
            browser.request("/update-user", {
              method: "POST",
              body: { name: "Aaron" },
            })
          )
          expect(renamed.status).toBe(200)
          const afterRename = yield* Effect.promise(() =>
            browser.listAccounts()
          )
          expect(afterRename.map(({ userId }) => userId)).toEqual(order)
          expect(afterRename.find(({ userId }) => userId === "bob")?.name).toBe(
            "Aaron"
          )

          for (const account of accounts) {
            // Exercise the same activation endpoint used by switchBrowserAccount
            // and keep its cookies, as a browser does across the full reload.
            const sessions = yield* Effect.promise(() =>
              auth.api.listDeviceSessions({ headers: browser.headers() })
            )
            const target = sessions.find(
              ({ session }) => session.id === account.sessionId
            )!
            const activated = yield* Effect.promise(() =>
              auth.api.setActiveSession({
                headers: browser.headers(),
                body: { sessionToken: target.session.token },
                returnHeaders: true,
              })
            )
            browser.store(activated.headers)

            const reloaded = yield* Effect.promise(() => browser.listAccounts())
            expect(reloaded.map(({ userId }) => userId)).toEqual(order)
            expect(reloaded.find(({ active }) => active)?.userId).toBe(
              account.userId
            )

            const confirmed = yield* Effect.promise(() =>
              browser.request("/password-confirmation/confirm", {
                method: "POST",
                body: { password },
              })
            )
            expect(confirmed.status).toBe(200)
            const refreshed = yield* Effect.promise(() =>
              browser.listAccounts()
            )
            expect(refreshed.map(({ userId }) => userId)).toEqual(order)
            const active = refreshed.find(({ active }) => active)
            expect(active?.userId).toBe(account.userId)
            expect(active?.sessionId).not.toBe(account.sessionId)
          }
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
      "signs one account out without ending the others",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("alice@example.test"))
          yield* Effect.promise(() => browser.signIn("bob@example.test"))

          const { listBrowserAccounts, signOutBrowserAccount } =
            yield* Effect.promise(() => import("@/lib/browser-accounts.server"))
          const accounts = yield* Effect.promise(() =>
            listBrowserAccounts(browser.headers())
          )
          const alice = accounts.find(({ userId }) => userId === "alice")!
          yield* Effect.promise(() =>
            signOutBrowserAccount(browser.headers(), alice.sessionId)
          )

          const sessions = yield* selectRows<{ userId: string }>("session")
          expect(sessions.map(({ userId }) => userId)).toEqual(["bob"])
        }),
      { timeout: 30_000 }
    )

    it.effect(
      "keeps a session from before multiple accounts when adding another",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("alice@example.test"))
          // Earlier releases set only the session cookie.
          for (const name of browser.cookies.keys())
            if (name.includes("_multi-")) browser.cookies.delete(name)

          const { auth } = yield* Effect.promise(() => import("@/lib/auth"))
          const remembered = yield* Effect.promise(() =>
            auth.api.rememberActiveBrowserSession({
              headers: browser.headers(),
              returnHeaders: true,
            })
          )
          browser.store(remembered.headers)
          yield* Effect.promise(() => browser.signIn("bob@example.test"))

          const { listBrowserAccounts } = yield* Effect.promise(
            () => import("@/lib/browser-accounts.server")
          )
          const accounts = yield* Effect.promise(() =>
            listBrowserAccounts(browser.headers())
          )
          expect(accounts.map(({ userId }) => userId)).toEqual(["alice", "bob"])
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

    it.effect(
      "offers every passkey when adding an account",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedAccount("alice")
          yield* seedAccount("bob")
          const passkey = (userId: string) => ({
            id: `passkey-${userId}`,
            publicKey: "public-key",
            userId,
            credentialID: `credential-${userId}`,
            counter: 0,
            deviceType: "multiDevice",
            backedUp: true,
            createdAt: new Date(),
          })
          yield* insertRows("passkey", [passkey("alice"), passkey("bob")])
          const browser = new Browser()
          yield* Effect.promise(() => browser.signIn("alice@example.test"))

          const response = yield* Effect.promise(() =>
            browser.request("/passkey/generate-authenticate-options", {
              headers: { "x-kiln-account": "alice" },
            })
          )
          expect(response.status).toBe(200)
          const options = yield* Effect.promise(() => response.json())
          // No allow list lets the browser offer Bob's passkey too.
          expect(options.allowCredentials ?? []).toEqual([])
        }),
      { timeout: 30_000 }
    )
  })
})
