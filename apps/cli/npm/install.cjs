const { execFile } = require("node:child_process")
const { createHash } = require("node:crypto")
const { existsSync } = require("node:fs")
const {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
} = require("node:fs/promises")
const { join } = require("node:path")
const { setTimeout: delay } = require("node:timers/promises")
const { promisify } = require("node:util")
const manifest = require("./package.json")

const execFileAsync = promisify(execFile)
const releasePattern = /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d{6})?$/u
const maximumBinarySize = 256 * 1024 * 1024

async function lookupRelease(repository, platform) {
  const requested = process.env.KILN_CLI_VERSION?.trim()
  const channel = process.env.KILN_CLI_CHANNEL?.trim() || "nightly"
  if (!["nightly", "stable"].includes(channel))
    throw new Error("KILN_CLI_CHANNEL must be nightly or stable.")
  if (requested && !releasePattern.test(`v${requested}`))
    throw new Error(
      "KILN_CLI_VERSION must be an exact Kiln release version, without v."
    )
  const endpoint = requested
    ? `releases/tags/v${requested}`
    : channel === "stable"
      ? "releases/latest"
      : "releases?per_page=100"
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${endpoint}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": manifest.name,
      },
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!response.ok)
    throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`)
  const body = await response.json()
  const releases = Array.isArray(body) ? body : [body]
  const candidates = releases
    .filter(
      (release) =>
        release &&
        release.draft === false &&
        releasePattern.test(release.tag_name) &&
        (requested
          ? release.tag_name === `v${requested}`
          : release.prerelease === (channel === "nightly") &&
            release.tag_name.includes("-nightly.") === (channel === "nightly"))
    )
    .sort((a, b) => {
      const left = a.tag_name.slice(1).split(/[.-]/u).map(Number)
      const right = b.tag_name.slice(1).split(/[.-]/u).map(Number)
      for (let i = 0; i < left.length; i++) {
        if (
          left[i] !== right[i] &&
          Number.isFinite(left[i]) &&
          Number.isFinite(right[i])
        )
          return right[i] - left[i]
      }
      return 0
    })
  // A release becomes visible before its CLI upload finishes. Until then, new
  // nightly installs use the newest complete release for this platform.
  for (const release of candidates) {
    const name = `kiln-${release.tag_name}-${platform}${platform === "windows-x64" ? ".exe" : ""}`
    const asset = release.assets?.find((entry) => entry.name === name)
    if (!asset) continue
    if (
      !/^sha256:[a-f\d]{64}$/u.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > maximumBinarySize ||
      asset.browser_download_url !==
        `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`
    )
      throw new Error(
        "GitHub returned invalid CLI asset metadata (URL, SHA-256 digest, or size)."
      )
    return { asset, version: release.tag_name.slice(1) }
  }
  throw new Error(
    `No complete ${requested || channel} CLI release is available for ${platform}. Try again after its CLI build finishes.`
  )
}

async function downloadBinary(asset, destination) {
  const signal = AbortSignal.timeout(300_000)
  const response = await fetch(asset.browser_download_url, { signal })
  if (!response.ok || !response.body)
    throw new Error(`CLI download failed (HTTP ${response.status}).`)
  const file = await open(destination, "wx", 0o700)
  try {
    const hash = createHash("sha256")
    let size = 0
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > asset.size)
        throw new Error("CLI download exceeded its expected size.")
      hash.update(chunk)
      await file.writeFile(chunk)
    }
    if (size !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest)
      throw new Error("CLI download failed its SHA-256 or size check.")
    await file.sync()
  } finally {
    await file.close()
  }
}

async function installBinary() {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  if (
    ![
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "windows-x64",
    ].includes(platform)
  )
    throw new Error(`Kiln does not publish a binary for ${platform}.`)
  const destination = join(
    __dirname,
    "native",
    process.platform === "win32" ? "kiln.exe" : "kiln"
  )
  if (existsSync(destination)) return destination
  const repository = manifest.kilnBootstrap.repository
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Invalid GitHub repository in the Kiln bootstrap package.")
  await mkdir(join(__dirname, "native"), { recursive: true })
  const lockPath = `${destination}.install-lock`
  const deadline = Date.now() + 360_000
  let lock
  while (!lock) {
    try {
      lock = await open(lockPath, "wx", 0o600)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (existsSync(destination)) return destination
      // Recover a lock left behind by a killed installer, beyond its maximum runtime.
      const previous = await stat(lockPath).catch((cause) => {
        if (cause.code !== "ENOENT") throw cause
      })
      if (previous && Date.now() - previous.mtimeMs > 15 * 60_000)
        await rm(lockPath, { force: true })
      if (Date.now() >= deadline)
        throw new Error(
          `Another Kiln installation is still running. Try again later, or remove ${lockPath} if it was interrupted.`
        )
      await delay(200)
    }
  }
  let temporary
  try {
    // Another launcher may have finished while this process acquired the lock.
    if (existsSync(destination)) return destination
    const { asset, version } = await lookupRelease(repository, platform)
    console.error(`Downloading Kiln ${version} from GitHub...`)
    temporary = await mkdtemp(join(__dirname, "native", ".install-"))
    const staged = join(
      temporary,
      process.platform === "win32" ? "kiln.exe" : "kiln"
    )
    await downloadBinary(asset, staged)
    await chmod(staged, 0o755)
    const { stdout } = await execFileAsync(staged, ["--version"], {
      timeout: 15_000,
      windowsHide: true,
    })
    if (stdout.trim() !== `kiln ${version}`)
      throw new Error("The downloaded binary reports an unexpected version.")
    await rename(staged, destination)
    return destination
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true })
    } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
}

module.exports = { installBinary }
if (require.main === module)
  installBinary().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
