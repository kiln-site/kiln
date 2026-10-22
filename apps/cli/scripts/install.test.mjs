import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, it } from "vite-plus/test"

const exec = promisify(execFile)
const directories = []
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const filename = process.platform === "win32" ? "kiln.exe" : "kiln"
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

it.skipIf(process.platform === "win32")(
  "installs the newest complete nightly once, including concurrent first launches, then works offline",
  async () => {
    const f = await fixture()
    f.response.releases = [
      { ...f.release, tag_name: "v1.2.0-nightly.20261023.123456", assets: [] },
      { ...f.release, tag_name: "v9.0.0-nightly.20261022.123456", draft: true },
      f.release,
      { ...f.release, tag_name: "v1.2.0-nightly.20261021.123456" },
    ]
    await f.save()
    const results = await Promise.all([f.run(), f.run()])
    for (const result of results)
      assert.equal(result.stdout.trim(), `kiln ${tag.slice(1)}`)
    f.response.offline = true
    await f.save()
    assert.equal((await f.run()).stdout.trim(), `kiln ${tag.slice(1)}`)
    assert.deepEqual(
      await readFile(join(f.directory, "native", filename)),
      executable
    )
    assert.deepEqual(await readdir(join(f.directory, "native")), [filename])
  }
)

it.each([
  "digest",
  "truncated",
  "oversized",
  "url",
  "missing-digest",
  "invalid-size",
])(
  "rejects a %s download without leaving an executable or lock behind",
  async (failure) => {
    const f = await fixture()
    if (failure === "digest")
      f.response.binary = Buffer.alloc(executable.length).toString("base64")
    if (failure === "truncated")
      f.response.binary = executable.subarray(1).toString("base64")
    if (failure === "oversized")
      f.response.binary = Buffer.concat([executable, executable]).toString(
        "base64"
      )
    if (failure === "url")
      f.asset.browser_download_url = "https://example.com/kiln"
    if (failure === "missing-digest") delete f.asset.digest
    if (failure === "invalid-size") f.asset.size = 300 * 1024 * 1024
    await f.save()
    await assert.rejects(f.run(), (error) => {
      assert.match(error.stderr, /SHA-256|expected size|invalid CLI asset/u)
      return true
    })
    assert.deepEqual(await readdir(join(f.directory, "native")), [])
  }
)

it.skipIf(process.platform === "win32")(
  "supports stable and exact release selection independently of the npm version",
  async () => {
    for (const exact of [false, true]) {
      const f = await fixture()
      f.response.endpoint = exact ? `releases/tags/${tag}` : "releases/latest"
      if (!exact) {
        const stableTag = "v1.2.0"
        f.release.tag_name = stableTag
        f.release.prerelease = false
        f.asset.name = f.asset.name.replace(tag, stableTag)
        f.asset.browser_download_url = f.asset.browser_download_url.replaceAll(
          tag,
          stableTag
        )
        f.response.assetUrl = f.asset.browser_download_url
        const stableBinary = Buffer.from('#!/bin/sh\nprintf "kiln 1.2.0\\n"\n')
        f.response.binary = stableBinary.toString("base64")
        f.asset.size = stableBinary.length
        f.asset.digest = `sha256:${createHash("sha256").update(stableBinary).digest("hex")}`
      }
      f.response.releases = f.release
      await f.save()
      if (exact)
        assert.equal(
          (await f.run({ KILN_CLI_VERSION: tag.slice(1) })).stdout.trim(),
          `kiln ${tag.slice(1)}`
        )
      else
        assert.equal(
          (await f.run({ KILN_CLI_CHANNEL: "stable" })).stdout.trim(),
          "kiln 1.2.0"
        )
    }
  }
)

it.skipIf(process.platform === "win32")(
  "refuses a valid download that reports the wrong executable version",
  async () => {
    const f = await fixture()
    const wrong = Buffer.from('#!/bin/sh\nprintf "kiln 9.0.0\\n"\n')
    f.response.binary = wrong.toString("base64")
    f.asset.size = wrong.length
    f.asset.digest = `sha256:${createHash("sha256").update(wrong).digest("hex")}`
    await f.save()
    await assert.rejects(f.run(), /unexpected version/u)
    assert.deepEqual(await readdir(join(f.directory, "native")), [])
  }
)
