import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import {
  listKilnReleasesEffect,
  recordComponentVersionsEffect,
  releaseHistoryPageEffect,
} from "@/effect/kiln-release-feed"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

const nightly = (build: number) => {
  const day = String(build).padStart(2, "0")
  return {
    publishedAt: `2026-08-${day}T00:00:00Z`,
    version: `0.1.0-nightly.202608${day}.000000`,
  }
}

// GitHub's release feed, newest first, split into pages. Every request is
// recorded so tests can see what Hearth asked GitHub for.
function serveReleasePages(
  pages: ReadonlyArray<ReadonlyArray<ReturnType<typeof nightly>>>
) {
  const requests: Array<number> = []
  serve = (input) => {
    const url = new URL(input)
    const page = Number(url.searchParams.get("page") ?? 1)
    requests.push(page)
    const releases = pages[page - 1] ?? []
    return Response.json(
      releases.map(({ publishedAt, version }) => ({
        assets: [
          {
            browser_download_url: `https://github.test/v${version}/release-manifest.json`,
            name: "release-manifest.json",
          },
        ],
        body: `* fix(web): change in ${version} by @someone in https://github.com/kiln-site/kiln/pull/1`,
        draft: false,
        html_url: `https://github.com/kiln-site/kiln/releases/tag/v${version}`,
        name: `v${version}`,
        prerelease: true,
        published_at: publishedAt,
        tag_name: `v${version}`,
      })),
      {
        headers:
          page < pages.length
            ? {
                link: `<${url.origin}${url.pathname}?page=${page + 1}>; rel="next"`,
              }
            : {},
      }
    )
  }
  return requests
}

let serve: (url: string) => Response = () =>
  new Response("not found", { status: 404 })
const GitHub = Layer.succeed(FetchHttpClient.Fetch)(async (input) =>
  serve(String(input instanceof Request ? input.url : input))
)

const recentVersions = Effect.map(listKilnReleasesEffect(), (releases) =>
  releases.map(({ version }) => version)
)

describeMysql("Kiln release feed", () => {
  layer(Layer.merge(TestDatabase, GitHub))((it) => {
    it.effect(
      "asks GitHub only for new releases, at most every few minutes",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const requests = serveReleasePages([[nightly(2), nightly(1)]])

          assert.deepStrictEqual(yield* recentVersions, [
            nightly(2).version,
            nightly(1).version,
          ])
          yield* recentVersions
          assert.deepStrictEqual(requests, [1])

          yield* TestClock.adjust("5 minutes")
          serveReleasePages([[nightly(3), nightly(2), nightly(1)]])
          assert.deepStrictEqual((yield* recentVersions)[0], nightly(3).version)
        })
    )

    it.effect("pages back through older releases only when asked", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const requests = serveReleasePages([
          [nightly(4), nightly(3)],
          [nightly(2), nightly(1)],
        ])

        yield* recentVersions
        assert.deepStrictEqual(requests, [1])

        const first = yield* releaseHistoryPageEffect(null, 3)
        assert.deepStrictEqual(
          first.releases.map(({ version }) => version),
          [nightly(4).version, nightly(3).version, nightly(2).version]
        )
        assert.deepStrictEqual(first.releases[0]?.changes[0]?.group, "fixed")
        assert.deepStrictEqual(requests, [1, 2])

        const rest = yield* releaseHistoryPageEffect(first.nextCursor, 3)
        assert.deepStrictEqual(
          rest.releases.map(({ version }) => version),
          [nightly(1).version]
        )
        assert.strictEqual(rest.nextCursor, null)
        // Hearth has every release now, so GitHub isn't asked again.
        yield* releaseHistoryPageEffect(null, 10)
        assert.deepStrictEqual(requests, [1, 2])
      })
    )

    it.effect("stops offering a release GitHub withdrew", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        serveReleasePages([[nightly(3), nightly(2), nightly(1)]])
        yield* recentVersions

        yield* TestClock.adjust("5 minutes")
        serveReleasePages([[nightly(2), nightly(1)]])
        assert.deepStrictEqual(yield* recentVersions, [
          nightly(2).version,
          nightly(1).version,
        ])
      })
    )

    it.effect(
      "finds a stable release's image version once its manifest loads",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const promoted = nightly(9).version
          const stable = {
            assets: [
              {
                browser_download_url: "https://github.test/v0.1.0/manifest",
                name: "release-manifest.json",
              },
            ],
            body: null,
            draft: false,
            html_url: "https://github.com/kiln-site/kiln/releases/tag/v0.1.0",
            name: "v0.1.0",
            prerelease: false,
            published_at: "2026-08-10T00:00:00Z",
            tag_name: "v0.1.0",
          }
          const serveStable = (manifest: boolean) => {
            serve = (url) =>
              url.endsWith("/manifest")
                ? manifest
                  ? Response.json({
                      channel: "stable",
                      commit: "0".repeat(40),
                      compatibility: { relayProtocol: 1 },
                      components: {
                        hearth: { digest: "sha256:h", image: "kiln/hearth" },
                        relay: { digest: "sha256:r", image: "kiln/relay" },
                      },
                      imageVersion: promoted,
                      publishedAt: "2026-08-10T00:00:00Z",
                      schemaVersion: 1,
                      version: "0.1.0",
                    })
                  : new Response("not found", { status: 404 })
                : Response.json([stable])
          }
          const aliases = Effect.map(
            listKilnReleasesEffect(),
            (releases) => releases[0]?.aliases ?? []
          )

          serveStable(false)
          assert.deepStrictEqual(yield* aliases, [])

          yield* TestClock.adjust("5 minutes")
          serveStable(true)
          assert.deepStrictEqual(yield* aliases, [promoted])
        })
    )

    it.effect("remembers the version each component ran before", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const first = nightly(1).version
        const second = nightly(2).version

        assert.deepStrictEqual(
          yield* recordComponentVersionsEffect([
            { key: "hearth", version: first },
            { key: "relay:a", version: "development" },
          ]),
          {}
        )
        yield* recordComponentVersionsEffect([
          { key: "hearth", version: second },
        ])
        assert.deepStrictEqual(
          yield* recordComponentVersionsEffect([
            { key: "hearth", version: second },
          ]),
          { hearth: first }
        )
      })
    )
  })
})
