import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, it } from "vite-plus/test"

const exec = promisify(execFile)
const directories = []
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const executable = Buffer.from(
  '#!/bin/sh\nprintf "kiln 1.2.0-nightly.20261022.123456\\n"\n'
)
const tag = "v1.2.0-nightly.20261022.123456"

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-bootstrap-"))
  directories.push(directory)
  for (const file of ["install.cjs", "kiln.cjs"])
    await copyFile(
      new URL(`../npm/${file}`, import.meta.url),
      join(directory, file)
    )
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "kiln-fixture",
      kilnBootstrap: { repository: "example/fixture" },
    })
  )
  const name = `kiln-${tag}-${platform}${process.platform === "win32" ? ".exe" : ""}`
  const asset = {
    name,
    size: executable.length,
    digest: `sha256:${createHash("sha256").update(executable).digest("hex")}`,
    browser_download_url: `https://github.com/example/fixture/releases/download/${tag}/${name}`,
  }
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [asset],
  }
  const preload = join(directory, "network.cjs")
  const data = join(directory, "response.json")
  await writeFile(
    preload,
    `
const { readFileSync } = require("node:fs")
const fixture = JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8"))
globalThis.fetch = async (url) => {
  if (fixture.offline) throw new Error("network unavailable")
  if (url === "https://api.github.com/repos/example/fixture/" + fixture.endpoint)
    return Response.json(fixture.releases)
  if (url === fixture.assetUrl)
    return new Response(Buffer.from(fixture.binary, "base64"))
  throw new Error("Unexpected network request: " + url)
}
`
  )
  const response = {
    endpoint: "releases?per_page=100",
    releases: [release],
    assetUrl: asset.browser_download_url,
    binary: executable.toString("base64"),
  }
  const save = () => writeFile(data, JSON.stringify(response))
  await save()
  const run = (environment = {}) =>
    exec(
      process.execPath,
      ["--require", preload, join(directory, "kiln.cjs"), "--version"],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          KILN_CLI_VERSION: "",
          KILN_CLI_CHANNEL: "",
          ...environment,
        },
      }
    )
  return { directory, asset, release, response, save, run }
}

it.each(["digest", "url", "missing-digest"])(
  "rejects a %s download without leaving an executable or lock behind",
  async (failure) => {
    const f = await fixture()
    if (failure === "digest")
      f.response.binary = Buffer.alloc(executable.length).toString("base64")
    if (failure === "url")
      f.asset.browser_download_url = "https://example.com/kiln"
    if (failure === "missing-digest") delete f.asset.digest
    await f.save()
    await assert.rejects(f.run(), (error) => {
      assert.match(error.stderr, /SHA-256|expected size|invalid CLI asset/u)
      return true
    })
    assert.deepEqual(await readdir(join(f.directory, "native")), [])
  }
)
