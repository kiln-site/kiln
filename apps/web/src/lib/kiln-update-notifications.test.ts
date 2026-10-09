import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { listNotificationsEffect } from "@/effect/notifications"
import {
  notifyLatestKilnReleaseEffect,
  recordStartedKilnVersionEffect,
} from "@/lib/kiln-update-notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

const updates = (userId: string) =>
  Effect.map(listNotificationsEffect(userId), (notifications) =>
    notifications.flatMap(({ content }) =>
      content.kind === "kiln.updated"
        ? [`${content.previousVersion} -> ${content.version}`]
        : []
    )
  )

const releaseNotices = (userId: string) =>
  Effect.map(listNotificationsEffect(userId), (notifications) =>
    notifications.flatMap(({ content }) =>
      content.kind === "kiln.release" ? [content.version] : []
    )
  )

// GitHub's release feed and manifests, the one boundary the release check
// crosses. Each release is [version, published, stable image version?].
function serveReleaseFeed(releases: ReadonlyArray<[string, string, string?]>) {
  const manifestUrl = (version: string) =>
    `https://github.test/releases/v${version}/release-manifest.json`
  const manifests = new Map(
    releases.map(([version, publishedAt, imageVersion]) => [
      manifestUrl(version),
      {
        channel: version.includes("nightly") ? "nightly" : "stable",
        commit: "0".repeat(40),
        compatibility: { relayProtocol: 1 },
        components: {
          hearth: { digest: "sha256:hearth", image: "kiln/hearth" },
          relay: { digest: "sha256:relay", image: "kiln/relay" },
        },
        ...(imageVersion ? { imageVersion } : {}),
        publishedAt,
        schemaVersion: 1,
        version,
      },
    ])
  )
  const feed = releases.map(([version, publishedAt]) => ({
    assets: [
      {
        browser_download_url: manifestUrl(version),
        name: "release-manifest.json",
      },
    ],
    body: null,
    draft: false,
    html_url: `https://github.com/kiln-site/kiln/releases/tag/v${version}`,
    name: `v${version}`,
    prerelease: version.includes("nightly"),
    published_at: publishedAt,
    tag_name: `v${version}`,
  }))
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input)
    const body =
      manifests.get(url) ?? (url.includes("/releases?") ? feed : null)
    return body
      ? Response.json(body)
      : new Response("not found", { status: 404 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describeMysql("Kiln update notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect("tells admins once when Hearth starts on a newer version", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("admin", { role: "admin" })
        yield* insertUser("member", { role: "user" })
        serveReleaseFeed([])

        // A fresh install has nothing to compare against.
        yield* recordStartedKilnVersionEffect("0.2.0")
        yield* recordStartedKilnVersionEffect("0.2.0")
        assert.deepStrictEqual(yield* updates("admin"), [])

        yield* recordStartedKilnVersionEffect("0.3.0")
        yield* recordStartedKilnVersionEffect("0.3.0")
        assert.deepStrictEqual(yield* updates("admin"), ["0.2.0 -> 0.3.0"])
        assert.deepStrictEqual(yield* updates("member"), [])

        // Rolling back is not an update.
        yield* recordStartedKilnVersionEffect("0.2.0")
        assert.deepStrictEqual(yield* updates("admin"), ["0.2.0 -> 0.3.0"])
      })
    )

    it.effect("never announces the stable release that is installed", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("admin", { role: "admin" })
        // Stable images keep the nightly version they were promoted from.
        const installed = "0.2.0-nightly.20260801.120000"
        const stable: [string, string, string] = [
          "0.2.0",
          "2026-08-02T00:00:00Z",
          installed,
        ]
        const promoted: [string, string] = [installed, "2026-08-01T12:00:00Z"]

        serveReleaseFeed([stable, promoted])
        yield* notifyLatestKilnReleaseEffect(installed)
        // A newer nightly on top of the feed changes nothing for stable users.
        serveReleaseFeed([
          ["0.3.0-nightly.20260805.090000", "2026-08-05T09:00:00Z"],
          stable,
          promoted,
        ])
        yield* notifyLatestKilnReleaseEffect(installed)
        assert.deepStrictEqual(yield* releaseNotices("admin"), [])

        serveReleaseFeed([
          ["0.3.0", "2026-08-09T00:00:00Z", "0.3.0-nightly.20260808.090000"],
          ["0.3.0-nightly.20260805.090000", "2026-08-05T09:00:00Z"],
          stable,
          promoted,
        ])
        yield* notifyLatestKilnReleaseEffect(installed)
        assert.deepStrictEqual(yield* releaseNotices("admin"), ["0.3.0"])
      })
    )

    it.effect(
      "clears release notices once installed or replaced by a newer one",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("admin", { role: "admin" })
          const installed = "0.2.0"
          const releases: Array<[string, string]> = [
            ["0.2.0", "2026-08-02T00:00:00Z"],
          ]

          releases.unshift(["0.3.0", "2026-08-09T00:00:00Z"])
          serveReleaseFeed(releases)
          yield* notifyLatestKilnReleaseEffect(installed)
          assert.deepStrictEqual(yield* releaseNotices("admin"), ["0.3.0"])

          releases.unshift(["0.4.0", "2026-08-16T00:00:00Z"])
          serveReleaseFeed(releases)
          yield* notifyLatestKilnReleaseEffect(installed)
          assert.deepStrictEqual(yield* releaseNotices("admin"), ["0.4.0"])

          // A feed that no longer lists it, say past GitHub's newest 100
          // releases, is no proof the notice is stale.
          serveReleaseFeed([])
          yield* notifyLatestKilnReleaseEffect(installed)
          assert.deepStrictEqual(yield* releaseNotices("admin"), ["0.4.0"])

          yield* notifyLatestKilnReleaseEffect("0.4.0")
          assert.deepStrictEqual(yield* releaseNotices("admin"), [])
        })
    )
  })
})
