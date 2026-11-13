import { assert, layer } from "@effect/vitest"
import { relayCatalogSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  saveBrickCatalogEffect,
  setBrickCatalogVisibilityEffect,
} from "@/effect/brick-catalogs"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const paper = (revision: number, commit: string) => ({
  format: "kiln.brick/v2",
  kind: "game-server",
  metadata: {
    id: "paper",
    name: "Paper",
    summary: "An example.",
    author: "Billy",
    revision,
  },
  deploy: { type: "image", image: `ghcr.io/billy/paper:${revision}` },
  source: `https://raw.githubusercontent.com/billy/bricks/${commit}/paper.yml`,
})
const installed = paper(1, "a".repeat(40)).source

// Kiln's own catalog is fetched over the network. Here it holds what each
// test gives it.
const kiln = vi.hoisted(() => ({ bricks: [] as Array<unknown> }))
vi.mock("@/server/brick-catalogs.server", () => ({
  defaultBrickCatalog: async () => ({ bricks: kiln.bricks }),
}))

import { newestBrickRevision } from "./brick-revisions.server"

// A copy of a catalog, read at a commit, as someone added it and as
// Hearth keeps it: Billy's own, unless it says otherwise.
const copy = (
  owner: string,
  revision: number,
  {
    community = false,
    repository = "billy/bricks",
    source,
  }: { community?: boolean; repository?: string; source?: string } = {}
) =>
  Effect.gen(function* () {
    const commit = String(revision).repeat(40)
    const id = yield* saveBrickCatalogEffect({
      ownerUserId: owner,
      revisionSha: commit,
      revisionUrl: `https://github.com/${repository}/blob/${commit}/catalog.yml`,
      snapshot: relayCatalogSchema.parse({
        format: "kiln.catalog/v1",
        name: "Billy's",
        bricks: [paper(revision, commit)],
      }),
      snapshotSha256: "0".repeat(64),
      source: source ?? `https://github.com/${repository}`,
    })
    if (community) {
      yield* setBrickCatalogVisibilityEffect({
        catalogId: id,
        community: true,
        publishedBy: owner,
      })
    }
  })

// What it finds is kept for a minute.
let now = Date.parse("2026-01-01T00:00:00Z")
const newest = Effect.promise(async () => {
  now += 5 * 60_000
  vi.setSystemTime(now)
  return (await newestBrickRevision(installed))?.revision ?? null
})

// A newer revision reaches every instance that follows the Brick, on
// Relays whoever added the catalog has no part in.
describeMysql("whose copy of a Brick says what its newest revision is", () => {
  layer(TestDatabase)((it) => {
    const seed = Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] })
      yield* resetDatabase
      kiln.bricks = []
      yield* insertUser("alice")
      yield* insertUser("bob")
    })

    it.effect("is the newest of the copies people added for themselves", () =>
      Effect.gen(function* () {
        yield* seed
        yield* copy("alice", 2)
        yield* copy("bob", 3)
        assert.strictEqual(yield* newest, 3)
      })
    )

    it.effect("is the published copy's, whatever anyone added since", () =>
      Effect.gen(function* () {
        yield* seed
        yield* copy("alice", 2, { community: true })
        yield* copy("bob", 3)
        assert.strictEqual(yield* newest, 2)
      })
    )

    // Stored before Kiln checked whose a catalog's recipes are, a copy may
    // hold a recipe its repository never published.
    it.effect("is never a copy's that may not be its repository's own", () =>
      Effect.gen(function* () {
        yield* seed
        yield* copy("alice", 2)
        // Listed by another repository's catalog.
        yield* copy("bob", 7, { repository: "mallory/bricks" })
        // Read at a commit by its ID, which a fork's can be, or by a way
        // Git reaches one.
        const fork = "https://raw.githubusercontent.com/billy/bricks"
        yield* copy("bob", 8, {
          source: `${fork}/${"8".repeat(40)}/catalog.yml`,
        })
        yield* copy("bob", 9, {
          source: `${fork}/${"9".repeat(40)}~0/catalog.yml`,
        })
        yield* copy("alice", 6, {
          source: `${fork}/${"6".repeat(40)}%5E0/catalog.yml`,
        })
        assert.strictEqual(yield* newest, 2)
      })
    )

    it.effect("is Kiln's own catalog's, for a Brick it holds", () =>
      Effect.gen(function* () {
        yield* seed
        kiln.bricks = [paper(2, "main")]
        yield* copy("alice", 4, { community: true })
        yield* copy("bob", 5)
        assert.strictEqual(yield* newest, 2)
      })
    )
  })
})
