import assert from "node:assert/strict"
import test from "node:test"

import {
  nightlyRollingTags,
  releaseConfiguration,
  resolveReleaseLine,
  validateNextReleaseLine,
  validateReleaseManifest,
  validateStablePromotion,
  workflowReleaseConfiguration,
} from "./release.mjs"
import { kilnImageRepository } from "../packages/contracts/src/git-repository.ts"
import { isKilnReleaseVersion } from "../packages/contracts/src/release-version.ts"

const repository = "https://github.com/example/fork"

test("fork release configuration uses its own identity and initial line", () => {
  const env = {
    GITHUB_REPOSITORY: "example/fork",
    KILN_INITIAL_RELEASE_LINE: "1.2.0",
  }
  const config = releaseConfiguration(env, "2026-09-30T13:14:15Z")
  assert.equal(config.prefix, "ghcr.io/example/fork")
  assert.equal(config.source, repository)
  assert.equal(config.repository, repository)
  assert.equal(config.version, "1.2.0-nightly.20260930.131415")
  assert.ok(isKilnReleaseVersion(config.version))
  assert.throws(
    () =>
      releaseConfiguration(
        { ...env, KILN_INITIAL_RELEASE_LINE: "bad" },
        "2026-09-30"
      ),
    /INITIAL_RELEASE_LINE/u
  )
})

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

test("release lines bootstrap once, then follow published stable metadata", () => {
  const cases = [
    [undefined, undefined, "0.1.0"],
    ["1.0.0", undefined, "1.0.0"],
    [undefined, { version: "0.1.0" }, "0.1.1"],
    ["0.2.0", { version: "0.1.0" }, "0.2.0"],
    // Stale repository settings cannot override the published next line.
    ["9.0.0", { version: "0.1.0", nextReleaseLine: "0.3.0" }, "0.3.0"],
  ]
  for (const [initial, stable, expected] of cases)
    assert.equal(resolveReleaseLine(initial, stable), expected)

  for (const next of [undefined, "0.1.0", "0.0.9", "0.2.0-nightly.1", "01.0.0"])
    assert.throws(() => validateNextReleaseLine("0.1.0", next), /next release/u)
  assert.equal(validateNextReleaseLine("0.1.0", "0.1.1"), "0.1.1")
  assert.throws(
    () =>
      resolveReleaseLine("0.3.0", {
        version: "0.2.0",
        nextReleaseLine: "0.1.0",
      }),
    /next release/u
  )
})

const publishedRelease = (version) => ({
  tag_name: `v${version}`,
  prerelease: version.includes("-nightly."),
})
const nightly = "1.2.0-nightly.20260930.120000"
const olderNightly = "1.2.0-nightly.20260929.120000"
const newerNightly = "1.2.0-nightly.20260930.130000"

test("a nightly retry keeps its original version across stable promotion", async () => {
  const records = new Map()
  const store = (runId) => ({
    read: async () => structuredClone(records.get(runId)),
    create: async (record) => {
      assert.ok(!records.has(runId), "must not overwrite durable metadata")
      records.set(runId, structuredClone(record))
    },
  })
  const environment = {
    GITHUB_REPOSITORY: "example/fork",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    KILN_INITIAL_RELEASE_LINE: "1.2.0",
    KILN_RESOLVE_RELEASE_LINE: "true",
  }
  const timestamp = "2026-09-30T12:00:00Z"
  let stable
  let requests = 0
  const loadStable = async () => {
    requests++
    return stable
  }
  const original = await workflowReleaseConfiguration(
    environment,
    timestamp,
    loadStable,
    store(environment.GITHUB_RUN_ID)
  )
  assert.equal(original.version, nightly)
  const saved = structuredClone(records.get(environment.GITHUB_RUN_ID))
  const published = [nightly, newerNightly].map(publishedRelease)
  validateStablePromotion(published, newerNightly)
  stable = { version: "1.2.0", nextReleaseLine: "1.3.0" }
  published.push(publishedRelease(stable.version))

  const retry = await workflowReleaseConfiguration(
    {
      ...environment,
      GITHUB_RUN_ATTEMPT: "2",
      KILN_INITIAL_RELEASE_LINE: "9.0.0",
    },
    timestamp,
    loadStable,
    store(environment.GITHUB_RUN_ID)
  )
  assert.deepEqual(retry, original)
  assert.equal(requests, 1, "retries must not query the current release line")
  assert.deepEqual(records.get(environment.GITHUB_RUN_ID), saved)
  assert.deepEqual(nightlyRollingTags(published, retry.version), [])

  const next = await workflowReleaseConfiguration(
    {
      ...environment,
      GITHUB_RUN_ID: "124",
    },
    "2026-09-30T14:00:00Z",
    loadStable,
    store("124")
  )
  assert.equal(next.version, "1.3.0-nightly.20260930.140000")
  assert.equal(requests, 2)
})

test("retry configuration fails closed if durable metadata is missing or mismatched", async () => {
  let record
  const store = {
    read: async () => {
      if (!record) throw new Error("Missing run tag")
      return record
    },
    create: async () => assert.fail("must not replace missing retry metadata"),
  }
  const environment = {
    GITHUB_REPOSITORY: "example/fork",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "a".repeat(40),
    KILN_RESOLVE_RELEASE_LINE: "true",
  }
  const timestamp = "2026-09-30T12:00:00Z"
  const resolve = () =>
    workflowReleaseConfiguration(
      environment,
      timestamp,
      () => {
        assert.fail("retry must not resolve a replacement version")
      },
      store
    )
  await assert.rejects(
    resolve,
    /Cannot load the original nightly release configuration/u
  )
  const saved = {
    runId: environment.GITHUB_RUN_ID,
    commit: environment.GITHUB_SHA,
    config: releaseConfiguration(environment, timestamp),
  }
  for (const invalid of [
    { ...saved, runId: "456" },
    { ...saved, commit: "b".repeat(40) },
    { ...saved, config: { ...saved.config, prefix: "ghcr.io/another/fork" } },
    {
      ...saved,
      config: { ...saved.config, version: "0.1.0-nightly.20260929.120000" },
    },
  ]) {
    record = invalid
    await assert.rejects(resolve, /Saved nightly configuration does not match/u)
  }
})

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
