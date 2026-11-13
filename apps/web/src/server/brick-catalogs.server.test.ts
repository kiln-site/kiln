import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

// The network is the only fake: what each HTTPS address answers.
const remote = vi.hoisted(() => ({ answers: new Map<string, string>() }))
vi.mock("node:https", async (importOriginal) => {
  const { PassThrough } = await import("node:stream")
  return {
    ...(await importOriginal<typeof import("node:https")>()),
    get: (
      url: URL,
      _options: unknown,
      respond: (response: unknown) => void
    ) => {
      const answer = remote.answers.get(url.href)
      const response = Object.assign(new PassThrough(), {
        headers: {},
        statusCode: answer === undefined ? 404 : 200,
      })
      queueMicrotask(() => {
        respond(response)
        response.end(answer ?? "")
      })
      return { once: () => undefined }
    },
  }
})
const signedIn = vi.hoisted(() => ({ id: "alice" }))
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireEligibleResourceUser: async (): Promise<AuthenticatedUser> => ({
    email: `${signedIn.id}@example.test`,
    emailVerified: true,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    id: signedIn.id,
    isDevelopmentBypass: false,
    name: signedIn.id,
    role: "admin",
    status: "enabled",
    twoFactorEnabled: false,
  }),
}))

import {
  addBrickCatalogHandler,
  setBrickCatalogCommunityHandler,
} from "./brick-catalogs.server"

// A catalog of game server Bricks, one for each ID, at an address, with
// its recipes in a folder.
const publish = (
  catalog: string,
  ids: ReadonlyArray<string>,
  folder = "bricks"
) => {
  remote.answers.set(
    `${catalog}/catalog.yml`,
    [
      "format: kiln.catalog/v1",
      "name: Test",
      "recipes:",
      ...ids.map((id) => `  - ${folder}/${id}.yml`),
      "",
    ].join("\n")
  )
  for (const id of ids) {
    remote.answers.set(
      `${catalog}/${folder}/${id}.yml`,
      [
        "format: kiln.brick/v2",
        "kind: game-server",
        `metadata: { id: ${id}, name: ${id}, summary: An example., author: Billy }`,
        "deploy: { type: image, image: ghcr.io/acme/game:1 }",
        "",
      ].join("\n")
    )
  }
  return `${catalog}/catalog.yml`
}

const as = <A>(userId: string, run: () => Promise<A>) =>
  Effect.promise(async () => {
    signedIn.id = userId
    return run().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error: String(error), ok: false as const })
    )
  })

const add = (userId: string, source: string) =>
  as(userId, () => addBrickCatalogHandler({ source }))

// A Brick goes by its ID after whose it is, so that name has to mean one
// Brick to whoever sees it.
describeMysql("the names Bricks go by across catalogs", () => {
  layer(TestDatabase)((it) => {
    const seed = Effect.gen(function* () {
      yield* resetDatabase
      remote.answers.clear()
      yield* insertUser("alice")
      yield* insertUser("bob")
    })

    it.effect("refuses a second Brick of one owner by an ID it has", () =>
      Effect.gen(function* () {
        yield* seed
        const first = publish("https://bricks.test/billy/games", ["paper"])
        assert.isTrue((yield* add("alice", first)).ok)
        // Another owner's Brick by that ID is another Brick.
        assert.isTrue(
          (yield* add(
            "alice",
            publish("https://bricks.test/carol/games", ["paper"])
          )).ok
        )
        // The same owner's, by another ID.
        assert.isTrue(
          (yield* add(
            "alice",
            publish("https://bricks.test/billy/more", ["folia"])
          )).ok
        )
        const clash = yield* add(
          "alice",
          publish("https://bricks.test/billy/other", ["velocity", "paper"])
        )
        assert.isFalse(clash.ok)
        if (!clash.ok) assert.include(clash.error, "bricks.test/billy:paper")
      })
    )

    it.effect("reads a catalog again where it already is", () =>
      Effect.gen(function* () {
        yield* seed
        const source = publish("https://bricks.test/billy/games", ["paper"])
        assert.isTrue((yield* add("alice", source)).ok)
        publish("https://bricks.test/billy/games", ["paper", "folia"])
        const again = yield* add("alice", source)
        assert.isTrue(again.ok)
        if (again.ok) assert.strictEqual(again.value.brickCount, 2)
      })
    )

    it.effect("refuses to publish a Brick by a name everyone already has", () =>
      Effect.gen(function* () {
        yield* seed
        const shared = yield* add(
          "alice",
          publish("https://bricks.test/billy/games", ["paper"])
        )
        assert.isTrue(shared.ok)
        if (!shared.ok) return
        const publishIt = (catalogId: string) =>
          as("alice", () =>
            setBrickCatalogCommunityHandler({ catalogId, community: true })
          )
        assert.isTrue((yield* publishIt(shared.value.id)).ok)
        // Alice's own, which only she sees, doesn't stand in Bob's way.
        assert.isTrue(
          (yield* add(
            "alice",
            publish("https://bricks.test/billy/other", ["folia"])
          )).ok
        )
        assert.isTrue(
          (yield* add(
            "bob",
            publish("https://bricks.test/billy/bobs", ["folia"])
          )).ok
        )
        // What's published does.
        assert.isFalse(
          (yield* add(
            "bob",
            publish("https://bricks.test/billy/again", ["paper"])
          )).ok
        )
      })
    )

    // Published, a catalog is seen beside each person's own, which only
    // they and an administrator see.
    it.effect(
      "refuses to publish a Brick by a name someone has one of their own by",
      () =>
        Effect.gen(function* () {
          yield* seed
          assert.isTrue(
            (yield* add(
              "bob",
              publish("https://bricks.test/billy/bobs", ["paper"])
            )).ok
          )
          const mine = yield* add(
            "alice",
            publish("https://bricks.test/billy/games", ["paper"])
          )
          assert.isTrue(mine.ok)
          if (!mine.ok) return
          const published = yield* as("alice", () =>
            setBrickCatalogCommunityHandler({
              catalogId: mine.value.id,
              community: true,
            })
          )
          assert.isFalse(published.ok)
          if (!published.ok) {
            assert.include(published.error, "bricks.test/billy:paper")
          }
        })
    )

    // A recipe that moved in its catalog is another Brick to whatever
    // follows the old one, though it kept its ID.
    it.effect(
      "refuses a newer copy of a published catalog whose Brick moved",
      () =>
        Effect.gen(function* () {
          yield* seed
          const source = publish("https://bricks.test/billy/games", ["paper"])
          const shared = yield* add("alice", source)
          assert.isTrue(shared.ok)
          if (!shared.ok) return
          assert.isTrue(
            (yield* as("alice", () =>
              setBrickCatalogCommunityHandler({
                catalogId: shared.value.id,
                community: true,
              })
            )).ok
          )
          // The same Bricks, read again by someone else, are the same.
          assert.isTrue((yield* add("bob", source)).ok)
          publish("https://bricks.test/billy/games", ["paper"], "moved")
          assert.isFalse((yield* add("bob", source)).ok)
        })
    )
  })
})
