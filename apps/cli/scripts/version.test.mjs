import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { it } from "vite-plus/test"

import { npmRegistryVersion, resolveCliVersion } from "./version.mjs"

it("uses the app release line for local builds", async () => {
  const repositoryRoot = await fixture({ releaseLine: "0.3.0" })
  assert.equal(
    await resolveCliVersion({ repositoryRoot, environment: {} }),
    "0.3.0"
  )
})

it("uses the exact app version supplied by a release build", async () => {
  const repositoryRoot = await fixture({ releaseLine: "0.3.0" })
  assert.equal(
    await resolveCliVersion({
      repositoryRoot,
      environment: { KILN_VERSION: "0.3.0-nightly.20260809.211537" },
    }),
    "0.3.0-nightly.20260809.211537"
  )
})

it("allows an isolated test build for the npm bootstrap", async () => {
  const repositoryRoot = await fixture({ releaseLine: "0.3.0" })
  assert.equal(
    await resolveCliVersion({
      repositoryRoot,
      environment: { KILN_VERSION: "0.3.0-test.20260809.211537" },
    }),
    "0.3.0-test.20260809.211537"
  )
})

it("rejects versions outside Kiln's release format", async () => {
  const repositoryRoot = await fixture({ releaseLine: "1.0.0-invalid" })
  await assert.rejects(
    resolveCliVersion({ repositoryRoot, environment: {} }),
    /Invalid Kiln CLI version/u
  )
})

it("depends on platform packages by the version the registry stores", () => {
  assert.equal(
    npmRegistryVersion("0.3.0-nightly.20260809.071537"),
    "0.3.0-nightly.20260809.71537"
  )
  assert.equal(
    npmRegistryVersion("0.3.0-nightly.20260809.000000"),
    "0.3.0-nightly.20260809.0"
  )
  assert.equal(npmRegistryVersion("1.10.0"), "1.10.0")
})

async function fixture(release) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "kiln-cli-version-"))
  await writeFile(join(repositoryRoot, "release.json"), JSON.stringify(release))
  return repositoryRoot
}
