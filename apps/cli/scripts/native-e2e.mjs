// Run on each release platform: real npm installs and replacement of a running image.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binaryName, dist, platform, root, version } from "./distribution.mjs"
import { packageMain } from "./package.mjs"

// Bun's final compile rename cannot cross Windows drives; keep fixtures on the build volume.
const directory = await mkdtemp(join(dist, "native-e2e-"))
const node = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim()
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    ...options,
  }).trim()
const npm = (args, cwd = directory) =>
  run("npm", args, {
    cwd,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  })

try {
  assert.ok(platform)
  assert.equal(run(join(dist, binaryName), ["--version"]), `kiln ${version}`)
  const fixtureSource = join(directory, "fixture.ts")
  await writeFile(
    fixtureSource,
    `
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { Effect } from ${JSON.stringify(join(root, "node_modules/effect/dist/index.js"))}
import { updateCliEffect } from ${JSON.stringify(join(root, "src/update.ts"))}
import { cliGitRepository, cliVersion } from ${JSON.stringify(join(root, "src/distribution.ts"))}
if (process.argv[2] === "--version") {
  console.log("kiln " + cliVersion)
} else {
  const bytes = readFileSync(process.env.KILN_TEST_NEXT)
  const name = "kiln-v1.1.0-${platform.name}${process.platform === "win32" ? ".exe" : ""}"
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (String(url) !== "https://api.github.com/repos/example/native-fixture/releases/latest") throw new Error("Wrong source repository: " + url)
      return Response.json({ tag_name: "v1.1.0", draft: false, prerelease: false,
        assets: [{ name, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
          browser_download_url: cliGitRepository + "/releases/download/v1.1.0/" + name }] })
    }
    return new Response(bytes)
  }
  const result = await Effect.runPromise(updateCliEffect())
  console.log(JSON.stringify(result))
}
`
  )
  for (const fixtureVersion of ["1.0.0", "1.1.0"]) {
    const outfile = join(
      directory,
      `kiln-${fixtureVersion}${process.platform === "win32" ? ".exe" : ""}`
    )
    run(process.execPath, [
      "build",
      fixtureSource,
      "--compile",
      "--outfile",
      outfile,
      "--define",
      `process.env.KILN_VERSION=${JSON.stringify(fixtureVersion)}`,
      "--define",
      'process.env.KILN_GIT_REPO="https://github.com/example/native-fixture"',
    ])
    if (process.platform === "darwin")
      run("codesign", [
        "--entitlements",
        join(root, "entitlements.plist"),
        "--sign",
        "-",
        "--force",
        outfile,
      ])
  }
  const oldBinary = join(
    directory,
    `kiln-1.0.0${process.platform === "win32" ? ".exe" : ""}`
  )
  const newBinary = join(
    directory,
    `kiln-1.1.0${process.platform === "win32" ? ".exe" : ""}`
  )
  const env = { ...process.env, KILN_TEST_NEXT: newBinary }

  await packageMain()
  const mainPackage = join(directory, "main-package")
  await cp(join(dist, "npm"), mainPackage, { recursive: true })
  const mainManifest = JSON.parse(
    await readFile(join(mainPackage, "package.json"), "utf8")
  )
  mainManifest.kilnBootstrap.repository = "example/native-fixture"
  await writeFile(
    join(mainPackage, "package.json"),
    JSON.stringify(mainManifest)
  )
  const preload = join(directory, "github.cjs")
  await writeFile(
    preload,
    `
const { readFileSync } = require("node:fs")
const { createHash } = require("node:crypto")
const bytes = readFileSync(${JSON.stringify(oldBinary)})
const name = "kiln-v1.0.0-${platform.name}${process.platform === "win32" ? ".exe" : ""}"
const assetUrl = "https://github.com/example/native-fixture/releases/download/v1.0.0/" + name
globalThis.fetch = async (url) => {
  if (url === "https://api.github.com/repos/example/native-fixture/releases/tags/v1.0.0")
    return Response.json({ tag_name: "v1.0.0", draft: false, prerelease: false,
      assets: [{ name, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), browser_download_url: assetUrl }] })
  if (url === assetUrl) return new Response(bytes)
  throw new Error("Unexpected GitHub request: " + url)
}
`
  )
  const launch = (launcher, args, options = {}) =>
    run(node, ["--require", preload, launcher, ...args], {
      ...options,
      env: { ...env, KILN_CLI_VERSION: "1.0.0", ...options.env },
    })
  const mainTarball = JSON.parse(npm(["pack", "./main-package", "--json"]))[0]
    .filename
  const prefix = join(directory, "installation")
  npm([
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--offline",
    join(directory, mainTarball),
  ])
  const installed = join(prefix, "node_modules", mainManifest.name)
  const launcher = join(installed, "kiln.cjs")
  // --ignore-scripts matches package managers that disable dependency lifecycle scripts.
  assert.equal(launch(launcher, ["--version"]), "kiln 1.0.0")
  // npm may rewrite the installed launcher (line endings on Windows checkouts),
  // so compare it with itself rather than with the source.
  const installedLauncher = digest(await readFile(launcher))
  assert.deepEqual(JSON.parse(launch(launcher, ["update"], { env })), {
    updated: true,
    version: "1.1.0",
  })
  assert.equal(launch(launcher, ["--version"]), "kiln 1.1.0")
  assert.equal(
    installedLauncher,
    digest(await readFile(launcher)),
    "updating must leave the npm launcher unchanged"
  )
  assert.deepEqual(JSON.parse(launch(launcher, ["update"], { env })), {
    updated: false,
    version: "1.1.0",
  })

  // A newer bootstrap downloads the selected GitHub version again.
  mainManifest.version = "9.0.0"
  await writeFile(
    join(mainPackage, "package.json"),
    JSON.stringify(mainManifest)
  )
  const reinstall = JSON.parse(npm(["pack", "./main-package", "--json"]))[0]
    .filename
  npm(["install", "--prefix", prefix, "--offline", join(directory, reinstall)])
  assert.equal(launch(launcher, ["--version"]), "kiln 1.0.0")

  // The direct GitHub-download installation follows the identical replacement path.
  assert.deepEqual(JSON.parse(run(oldBinary, ["update"], { env })), {
    updated: true,
    version: "1.1.0",
  })
  assert.equal(run(oldBinary, ["--version"]), "kiln 1.1.0")
  console.log(
    "GitHub bootstrap installation, self-update, npm reinstall, and standalone replacement passed."
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
