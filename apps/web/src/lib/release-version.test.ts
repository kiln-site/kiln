import { describe, expect, it } from "vite-plus/test"

import {
  compareLatestReleaseVersion,
  compareReleaseVersions,
  isKilnReleaseVersion,
  newerStableRelease,
  orderKilnReleases,
} from "@/lib/release-version"

const publishedAt = new Map<string, string | null>([
  ["0.1.0-nightly.17", "2026-07-23T00:00:00.000Z"],
  ["0.1.0", "2026-07-24T00:00:00.000Z"],
  ["0.1.0-nightly.19", "2026-07-25T00:00:00.000Z"],
])

describe("release version ordering", () => {
  it("accepts valid UTC timestamp nightlies", () => {
    expect(isKilnReleaseVersion("0.1.0-nightly.20260726.171530")).toBe(true)
    expect(isKilnReleaseVersion("0.1.0-nightly.20260230.171530")).toBe(false)
    expect(isKilnReleaseVersion("0.1.0-nightly.20260726.246000")).toBe(false)
  })

  it("orders same-line stable and nightly releases by publication", () => {
    expect(
      compareReleaseVersions("0.1.0-nightly.19", "0.1.0", publishedAt)
    ).toBe(1)
    expect(
      compareReleaseVersions("0.1.0-nightly.17", "0.1.0", publishedAt)
    ).toBe(-1)
  })

  it("orders different release lines numerically", () => {
    const misleadingPublicationOrder = new Map(publishedAt)
    misleadingPublicationOrder.set(
      "0.2.0-nightly.1",
      "2026-07-22T00:00:00.000Z"
    )
    expect(
      compareReleaseVersions(
        "0.2.0-nightly.1",
        "0.1.0",
        misleadingPublicationOrder
      )
    ).toBe(1)
  })

  it("falls back to stable SemVer precedence without publication data", () => {
    expect(compareReleaseVersions("0.1.0", "0.1.0-nightly.19", new Map())).toBe(
      1
    )
  })

  it("orders GitHub's non-chronological release response numerically", () => {
    const releases = [8, 7, 6, 12, 11, 10, 5].map((nightly) => ({
      publishedAt: `2026-07-26T${String(nightly).padStart(2, "0")}:00:00.000Z`,
      version: `0.1.0-nightly.${nightly}`,
    }))

    expect(
      orderKilnReleases(releases).map((release) => release.version)
    ).toEqual([
      "0.1.0-nightly.12",
      "0.1.0-nightly.11",
      "0.1.0-nightly.10",
      "0.1.0-nightly.8",
      "0.1.0-nightly.7",
      "0.1.0-nightly.6",
      "0.1.0-nightly.5",
    ])
  })

  it("finds the latest release even when the feed is unordered", () => {
    const releases = [8, 7, 6, 12, 11, 10].map((nightly) => ({
      publishedAt: null,
      version: `0.1.0-nightly.${nightly}`,
    }))

    expect(compareLatestReleaseVersion("0.1.0-nightly.12", releases)).toBe(0)
    expect(compareLatestReleaseVersion("0.1.0-nightly.8", releases)).toBe(1)
  })

  it("orders timestamp nightlies without relying on publication metadata", () => {
    const releases = [
      "0.1.0-nightly.20260726.051833",
      "0.1.0-nightly.20260726.155759",
      "0.1.0-nightly.20260725.201552",
    ].map((version) => ({ publishedAt: null, version }))

    expect(
      orderKilnReleases(releases).map((release) => release.version)
    ).toEqual([
      "0.1.0-nightly.20260726.155759",
      "0.1.0-nightly.20260726.051833",
      "0.1.0-nightly.20260725.201552",
    ])
  })

  it("treats a migrated baked version as its timestamp release", () => {
    const releases = [
      {
        aliases: ["0.1.0-nightly.12"],
        publishedAt: "2026-07-26T15:57:59.000Z",
        version: "0.1.0-nightly.20260726.155759",
      },
    ]

    expect(compareLatestReleaseVersion("0.1.0-nightly.12", releases)).toBe(0)
  })
})

describe("newer stable release", () => {
  const release = (
    version: string,
    publishedAt: string | null,
    channel: "nightly" | "stable" = version.includes("nightly")
      ? "nightly"
      : "stable"
  ) => ({ channel, publishedAt, version })
  const feed = [
    release("0.2.0-nightly.21", "2026-08-03T00:00:00.000Z"),
    release("0.2.0", "2026-08-02T00:00:00.000Z"),
    release("0.2.0-nightly.19", "2026-08-01T00:00:00.000Z"),
    release("0.1.0", "2026-07-01T00:00:00.000Z"),
  ]

  it("offers a stable release published after the installed build", () => {
    expect(newerStableRelease("0.1.0", feed)?.version).toBe("0.2.0")
    expect(newerStableRelease("0.2.0-nightly.19", feed)?.version).toBe("0.2.0")
  })

  it("never offers an older stable release to a later nightly", () => {
    expect(newerStableRelease("0.2.0-nightly.21", feed)).toBeNull()
    expect(newerStableRelease("0.2.0", feed)).toBeNull()
  })

  it("stays quiet when the installed nightly's date is unknown", () => {
    expect(newerStableRelease("0.2.0-nightly.5", feed)).toBeNull()
  })
})
