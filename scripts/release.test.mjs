import assert from "node:assert/strict"
import test from "node:test"

import { releaseConfiguration, validateReleaseManifest } from "./release.mjs"
import {
  kilnCliPackageName,
  kilnDefaultEmberImage,
  kilnImageRepository,
} from "../packages/contracts/src/git-repository.ts"
import {
  isKilnReleaseVersion,
  compareKilnReleaseVersions,
} from "../packages/contracts/src/release-version.ts"

const repository = "https://github.com/example/fork"

test("a fork keeps its identity and version line after an upstream merge", () => {
  const env = {
    GITHUB_REPOSITORY: "example/fork",
    KILN_RELEASE_LINE: "1.2.0",
    PUBLISH_IMAGES: "true",
  }
  const first = releaseConfiguration(env, "2026-09-29T12:13:14Z")
  const merged = releaseConfiguration(env, "2026-09-30T13:14:15Z")
  assert.equal(first.prefix, "ghcr.io/example/fork")
  assert.equal(first.source, repository)
  assert.equal(merged.repository, first.repository)
  assert.equal(merged.prefix, first.prefix)
  assert.equal(merged.version, "1.2.0-nightly.20260930.131415")
  assert.ok(isKilnReleaseVersion(merged.version))
  assert.equal(compareKilnReleaseVersions(merged.version, first.version), 1)
  assert.throws(
    () => releaseConfiguration({ ...env, KILN_RELEASE_LINE: "" }, "2026-09-29"),
    /RELEASE_LINE/u
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

test("CLI identity supports scoped fork packages and rejects shell syntax", () => {
  assert.equal(kilnCliPackageName(undefined, repository), "@example/fork-cli")
  assert.equal(
    kilnCliPackageName("@my-npm-org/cli", repository),
    "@my-npm-org/cli"
  )
  for (const name of ["cli;echo", "cli@latest", "$(whoami)", "--registry=evil"])
    assert.throws(() => kilnCliPackageName(name))
})

test("default fork catalog selects fork Embers without rewriting third-party images", () => {
  assert.equal(
    kilnDefaultEmberImage(
      "ghcr.io/kiln-site/bricks-java:{{ variables.java_version }}",
      repository
    ),
    "ghcr.io/example/fork/bricks-java:{{ variables.java_version }}"
  )
  assert.equal(
    kilnDefaultEmberImage(
      "ghcr.io/kiln-site/bricks-steamcmd:latest",
      repository
    ),
    "ghcr.io/example/fork/bricks-steamcmd:latest"
  )
  assert.equal(
    kilnDefaultEmberImage("custom/java:21", repository),
    "custom/java:21"
  )
})
