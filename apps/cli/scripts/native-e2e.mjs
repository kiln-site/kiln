// Run on each release platform: real npm installs and replacement of a running image.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { binaryName, dist, platform, root, version } from "./distribution.mjs"

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
  assert.equal(
    digest(await readFile(join(dist, binaryName))),
    digest(await readFile(join(dist, "npm-platform", "bin", binaryName))),
    "npm must contain exactly the release binary"
  )
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
  const result = await Effect.runPromise(updateCliEffect({ fetch: async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (String(url) !== "https://api.github.com/repos/example/native-fixture/releases/latest") throw new Error("Wrong source repository: " + url)
      return Response.json({ tag_name: "v1.1.0", draft: false, prerelease: false,
        assets: [{ name, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
          browser_download_url: cliGitRepository + "/releases/download/v1.1.0/" + name }] })
    }
    return new Response(bytes)
  }}))
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

  const mainPackage = join(directory, "main-package")
  const platformPackage = join(directory, "platform-package")
  await cp(join(dist, "npm"), mainPackage, { recursive: true })
  await cp(join(dist, "npm-platform"), platformPackage, { recursive: true })
  // Fixtures exercise updates without publishing test releases or changing a real install.
  await copyFile(oldBinary, join(platformPackage, "bin", binaryName))
  const mainManifest = JSON.parse(
    await readFile(join(mainPackage, "package.json"), "utf8")
  )
  const platformManifest = JSON.parse(
    await readFile(join(platformPackage, "package.json"), "utf8")
  )
  const nativeTarball = JSON.parse(
    npm(["pack", "./platform-package", "--json"])
  )[0].filename
  mainManifest.optionalDependencies = {
    [platformManifest.name]: `file:${join(directory, nativeTarball)}`,
  }
  await writeFile(
    join(mainPackage, "package.json"),
    JSON.stringify(mainManifest)
  )
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
  assert.equal(run(node, [launcher, "--version"]), "kiln 1.0.0")
  assert.deepEqual(JSON.parse(run(node, [launcher, "update"], { env })), {
    updated: true,
    version: "1.1.0",
  })
  assert.equal(run(node, [launcher, "--version"]), "kiln 1.1.0")
  assert.equal(
    run(
      join(prefix, "node_modules", platformManifest.name, "bin", binaryName),
      ["--version"]
    ),
    "kiln 1.0.0",
    "updating must leave npm's binary unchanged"
  )
  assert.deepEqual(JSON.parse(run(node, [launcher, "update"], { env })), {
    updated: false,
    version: "1.1.0",
  })

  // Reinstalling a newer npm package takes ownership of the selected version again.
  mainManifest.version = "9.0.0"
  await writeFile(
    join(mainPackage, "package.json"),
    JSON.stringify(mainManifest)
  )
  const reinstall = JSON.parse(npm(["pack", "./main-package", "--json"]))[0]
    .filename
  npm(["install", "--prefix", prefix, "--offline", join(directory, reinstall)])
  assert.equal(run(node, [launcher, "--version"]), "kiln 1.0.0")

  // The direct GitHub-download installation follows the identical replacement path.
  assert.deepEqual(JSON.parse(run(oldBinary, ["update"], { env })), {
    updated: true,
    version: "1.1.0",
  })
  assert.equal(run(oldBinary, ["--version"]), "kiln 1.1.0")
  console.log(
    "Native npm installation, GitHub self-update, npm reinstall, and standalone replacement passed."
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
