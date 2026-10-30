import { describe, expect, it } from "vite-plus/test"

import {
  compareReleaseVersions,
  orderKilnReleases,
} from "@/lib/release-version"

const publishedAt = new Map<string, string | null>([
  ["0.1.0-nightly.17", "2026-07-23T00:00:00.000Z"],
  ["0.1.0", "2026-07-24T00:00:00.000Z"],
  ["0.1.0-nightly.19", "2026-07-25T00:00:00.000Z"],
])

describe("release version ordering", () => {
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
})
