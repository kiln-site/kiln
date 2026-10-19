import { createHmac, generateKeyPairSync } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { betterAuthSecrets } from "@/lib/environment"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

import { encryptWithKeyring } from "../../keyring.mjs"

import {
  completeGitHubInstallation,
  handleGitHubWebhook,
} from "./github-sync.server"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const connectionId = "11111111-1111-4111-8111-111111111111"
const appId = 4242
const installationId = 777
const webhookSecret = "webhook-secret"
const owner = { id: "owner-user" } as AuthenticatedUser

const insertConnection = Effect.gen(function* () {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  yield* insertRows("github_connection", {
    id: connectionId,
    owner_user_id: owner.id,
    app_id: appId,
    app_slug: "kiln-test",
    app_name: "Kiln test",
    app_url: "https://github.com/apps/kiln-test",
    app_owner_login: "octo",
    client_id: "Iv1.test",
    credentials_ciphertext: encryptWithKeyring(
      JSON.stringify({
        clientSecret: "client-secret",
        privateKey: privateKey.export({ format: "pem", type: "pkcs1" }),
        webhookSecret,
      }),
      betterAuthSecrets(),
      "kiln-github-app-credentials"
    ),
    webhook_active: true,
    installation_id: installationId,
    account_login: "octo",
    account_type: "User",
    repository_selection: "selected",
    suspended: false,
    created_at: 0,
    updated_at: 0,
  })
})

const installationIds = Effect.map(
  selectRows<{ installation_id: number | null }>("github_connection"),
  (rows) => rows.map((row) => row.installation_id)
)

function delivery(event: string, body: unknown, secret = webhookSecret) {
  const payload = JSON.stringify(body)
  return new Request("https://hearth.test/api/github/webhook", {
    body: payload,
    headers: {
      "x-github-event": event,
      "x-github-hook-installation-target-id": String(appId),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    method: "POST",
  })
}

const uninstalled = {
  action: "deleted",
  installation: {
    account: { login: "octo", type: "User" },
    app_id: appId,
    id: installationId,
    repository_selection: "selected",
  },
}

// GitHub, answering for one installation of whichever app a test says owns
// it. Effect's fetch client keeps the first `fetch` it sees, so the fake is
// installed once and its answer changes instead.
let installationOwnerAppId = appId
const github = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.pathname === `/app/installations/${installationId + 1}`) {
    return Response.json({
      account: { login: "someone-else", type: "Organization" },
      app_id: installationOwnerAppId,
      id: installationId + 1,
      repository_selection: "all",
    })
  }
  return Response.json({ message: "Not Found" }, { status: 404 })
})

beforeAll(() => {
  vi.stubGlobal("fetch", github)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await disposeAppRuntime()
})

describeMysql("GitHub webhooks", () => {
  layer(TestDatabase)((it) => {
    it.effect("ignores a delivery signed with the wrong secret", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertConnection

        const response = yield* Effect.promise(() =>
          handleGitHubWebhook(delivery("installation", uninstalled, "guess"))
        )

        assert.strictEqual(response.status, 401)
        assert.deepEqual(yield* installationIds, [installationId])
      })
    )

    it.effect("forgets an installation GitHub reports deleted", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertConnection

        const response = yield* Effect.promise(() =>
          handleGitHubWebhook(delivery("installation", uninstalled))
        )

        assert.strictEqual(response.status, 204)
        assert.deepEqual(yield* installationIds, [null])
      })
    )
  })
})

describeMysql("GitHub installation setup", () => {
  layer(TestDatabase)((it) => {
    it.effect("refuses an installation of another GitHub App", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertConnection
        installationOwnerAppId = appId + 1

        const result = yield* Effect.promise(() =>
          completeGitHubInstallation({
            installationId: installationId + 1,
            state: null,
            user: owner,
          }).then(
            () => "attached",
            (cause: Error) => cause.message
          )
        )

        assert.match(result, /doesn't belong to a GitHub App you connected/u)
        assert.deepEqual(yield* installationIds, [installationId])
      })
    )

    it.effect("attaches an installation of the person's own app", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertConnection
        installationOwnerAppId = appId

        const next = yield* Effect.promise(() =>
          completeGitHubInstallation({
            installationId: installationId + 1,
            state: null,
            user: owner,
          })
        )

        assert.strictEqual(next, `/infra/sources?connected=${connectionId}`)
        assert.deepEqual(yield* installationIds, [installationId + 1])
      })
    )
  })
})
