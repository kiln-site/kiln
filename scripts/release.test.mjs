import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import {
  nightlyRollingTags,
  validateReleaseManifest,
  validateStablePromotion,
} from "./release.mjs"
import { kilnImageRepository } from "../packages/contracts/src/git-repository.ts"

const repository = "https://github.com/example/fork"

test("fork manifests cannot select upstream or another fork's images", () => {
  const manifest = {
    schemaVersion: 1,
    channel: "stable",
    version: "1.2.0",
    commit: "a".repeat(40),
    compatibility: { relayProtocol: 3 },
    components: {
      hearth: {
        image: kilnImageRepository("hearth", repository),
        digest: `sha256:${"b".repeat(64)}`,
      },
      relay: {
        image: kilnImageRepository("relay", repository),
        digest: `sha256:${"c".repeat(64)}`,
      },
    },
  }
  validateReleaseManifest(manifest, repository, "1.2.0")
  assert.throws(
    () => validateReleaseManifest(null, repository, "1.2.0"),
    /Invalid/u
  )
  assert.throws(
    () =>
      validateReleaseManifest(
        { ...manifest, channel: "nightly" },
        repository,
        "1.2.0"
      ),
    /Invalid/u
  )
  assert.throws(
    () =>
      validateReleaseManifest(
        {
          ...manifest,
          components: {
            ...manifest.components,
            extra: manifest.components.relay,
          },
        },
        repository,
        "1.2.0"
      ),
    /Unexpected/u
  )
  assert.throws(
    () =>
      validateReleaseManifest(
        manifest,
        "https://github.com/another/fork",
        "1.2.0"
      ),
    /Unexpected/u
  )
  manifest.components.hearth.image = kilnImageRepository("hearth")
  assert.throws(
    () => validateReleaseManifest(manifest, repository, "1.2.0"),
    /Unexpected/u
  )
})

const publishedRelease = (version) => ({
  tag_name: `v${version}`,
  prerelease: version.includes("-nightly."),
})
const nightly = "1.2.0-nightly.20260930.120000"
const olderNightly = "1.2.0-nightly.20260929.120000"
const newerNightly = "1.2.0-nightly.20260930.130000"

test("nightly rolling tags never move backwards or replace an established stable", () => {
  const cases = [
    { name: "first release", versions: [], tags: ["latest-nightly", "latest"] },
    {
      name: "newest nightly before stable",
      versions: [olderNightly],
      tags: ["latest-nightly", "latest"],
    },
    {
      name: "retry before stable",
      versions: [nightly],
      tags: ["latest-nightly", "latest"],
    },
    {
      name: "stable owns latest",
      versions: ["1.1.0", olderNightly],
      tags: ["latest-nightly"],
    },
    {
      name: "retry after promotion",
      versions: [nightly, "1.2.0"],
      tags: ["latest-nightly"],
    },
    { name: "older retry", versions: [olderNightly, newerNightly], tags: [] },
    {
      name: "newer release line",
      versions: ["1.3.0-nightly.20260929.120000", nightly],
      tags: [],
    },
  ]
  for (const { name, versions, tags } of cases)
    assert.deepEqual(
      nightlyRollingTags(versions.map(publishedRelease), nightly),
      tags,
      name
    )
})

test("stable promotion requires the newest nightly in its line and cannot roll back stable", () => {
  const cases = [
    { name: "first promotion", versions: [olderNightly, nightly] },
    {
      name: "newer stable",
      versions: [nightly, "1.3.0"],
      error: /newer stable/u,
    },
    {
      name: "newer nightly in the same line",
      versions: [nightly, newerNightly, olderNightly],
      error: /newest nightly/u,
    },
    { name: "retry same stable", versions: [nightly, "1.2.0"] },
    {
      name: "other nightly lines do not block promotion",
      versions: ["1.3.0-nightly.20260930.130000", "1.1.0", nightly],
    },
    {
      name: "missing release",
      versions: [olderNightly],
      error: /existing nightly/u,
    },
    {
      name: "stable input",
      input: "1.2.0",
      versions: ["1.2.0"],
      error: /Invalid nightly/u,
    },
  ]
  for (const { name, input = nightly, versions, error } of cases) {
    const published = versions.map(publishedRelease)
    if (error)
      assert.throws(
        () => validateStablePromotion(published, input),
        error,
        name
      )
    else
      assert.equal(
        validateStablePromotion(published, input).tag_name,
        `v${input}`,
        name
      )
  }
})
