import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { Clock, Context, Effect, Schema } from "effect"
import {
  compareKilnReleaseVersions,
  isKilnNightlyVersion,
  isKilnReleaseVersion,
  kilnGitRepositoryApiUrl,
} from "@workspace/contracts"

import { cliGitRepository, cliVersion } from "./distribution.js"
import { CliCommandError, commandError } from "./errors.js"

const execFileAsync = promisify(execFile)
const maximumBinarySize = 256 * 1024 * 1024
// Longer than any update can run, so only a killed update's lock is reclaimed.
const staleLockAge = 15 * 60 * 1000
const releaseSchema = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.optional(Schema.NullOr(Schema.String)),
      browser_download_url: Schema.String,
    })
  ),
})
type Release = typeof releaseSchema.Type
type Asset = Release["assets"][number]

// The running installation that `kiln update` replaces.
export const CliInstallation = Context.Reference<{
  readonly arch: string
  readonly currentVersion: string
  readonly executablePath: string
  readonly platform: NodeJS.Platform
  readonly repository: string
  readonly standalone: boolean
}>("kiln-cli/update/CliInstallation", {
  defaultValue: () => ({
    arch: process.arch,
    currentVersion: cliVersion,
    executablePath: process.execPath,
    platform: process.platform,
    repository: cliGitRepository,
    standalone: isStandaloneCliBinary(process.argv[1] ?? ""),
  }),
})

export const updateCliEffect = Effect.fn("cli.update")(function* () {
  const {
    arch,
    currentVersion,
    executablePath,
    platform,
    repository,
    standalone,
  } = yield* CliInstallation
  if (!standalone) {
    return yield* commandError({
      code: "cli_update_development",
      message:
        "Run kiln update from an installed CLI binary, not the source checkout.",
    })
  }
  const release = yield* updateOperation((signal) =>
    findRelease(repository, currentVersion, signal)
  )
  const version = release.tag_name.slice(1)
  if (compareKilnReleaseVersions(version, currentVersion) !== 1) {
    return { updated: false, version: currentVersion }
  }
  const asset = yield* Effect.try({
    try: () => selectBinary(release, repository, platform, arch),
    catch: updateError,
  })
  const target = yield* updateOperation(() => realpath(executablePath))

  // Lock the actual executable, including when invoked through a symlink.
  return yield* Effect.acquireUseRelease(
    acquireLock(`${target}.update-lock`),
    () =>
      Effect.acquireUseRelease(
        updateOperation(() => mkdtemp(join(dirname(target), ".kiln-update-"))),
        (directory) =>
          Effect.gen(function* () {
            const staged = join(
              directory,
              platform === "win32" ? "kiln.exe" : "kiln"
            )
            yield* downloadBinary(asset, staged)
            yield* updateOperation(async (signal) => {
              signal.throwIfAborted()
              const original = await stat(target)
              await chmod(staged, original.mode & 0o777)
              await verifyBinary(staged, version, signal)
            })
            yield* replaceBinary(staged, target, platform)
            return { updated: true, version }
          }),
        (directory) =>
          // Cleanup is best-effort: it must not fail an update that already succeeded.
          Effect.tryPromise(() =>
            rm(directory, { recursive: true, force: true })
          ).pipe(Effect.ignore)
      ),
    (lock) =>
      Effect.tryPromise(async () => {
        await lock.close()
        await rm(`${target}.update-lock`, { force: true })
      }).pipe(Effect.ignore)
  )
})

function updateOperation<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: updateError })
}

function updateError(cause: unknown): CliCommandError {
  if (cause instanceof CliCommandError) return cause
  return commandError({
    cause,
    code: "cli_update_failed",
    message:
      "Could not update the Kiln CLI. Check the error below, installation-directory permissions, and whether another update is running.",
  })
}

const acquireLock = Effect.fn("cli.update.acquireLock")(function* (
  path: string
) {
  const create = updateOperation(() => open(path, "wx", 0o600))
  return yield* create.pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        // A killed update cannot release its lock; it must not block updates forever.
        const lock = yield* updateOperation(() => stat(path)).pipe(
          Effect.mapError(() => cause)
        )
        const now = yield* Clock.currentTimeMillis
        if (now - lock.mtimeMs < staleLockAge) return yield* cause
        yield* updateOperation(() => rm(path, { force: true }))
        return yield* create
      })
    )
  )
})

async function findRelease(
  repository: string,
  currentVersion: string,
  signal: AbortSignal
): Promise<Release> {
  if (!isKilnReleaseVersion(currentVersion)) {
    throw new Error(
      `Cannot select an update channel for version ${currentVersion}.`
    )
  }
  const nightly = isKilnNightlyVersion(currentVersion)
  const url = kilnGitRepositoryApiUrl(
    repository,
    nightly ? "releases?per_page=100" : "releases/latest"
  )
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kiln-cli",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!response.ok)
    throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`)
  const body: unknown = await response.json()
  const releases = nightly
    ? Schema.decodeUnknownSync(Schema.Array(releaseSchema))(body)
    : [Schema.decodeUnknownSync(releaseSchema)(body)]
  const selected = releases
    .filter((release) => {
      const version = release.tag_name.slice(1)
      return (
        !release.draft &&
        release.tag_name.startsWith("v") &&
        isKilnReleaseVersion(version) &&
        release.prerelease === nightly &&
        isKilnNightlyVersion(version) === nightly
      )
    })
    .sort(
      (a, b) =>
        compareKilnReleaseVersions(b.tag_name.slice(1), a.tag_name.slice(1)) ??
        0
    )[0]
  if (!selected)
    throw new Error(
      `No ${nightly ? "nightly" : "stable"} CLI release is available.`
    )
  return selected
}

function selectBinary(
  release: Release,
  repository: string,
  platform: string,
  arch: string
): Asset {
  const os = platform === "win32" ? "windows" : platform
  if (
    !(arch === "x64" || arch === "arm64") ||
    !["linux", "darwin", "windows"].includes(os) ||
    (os === "windows" && arch !== "x64")
  ) {
    throw new Error(`No CLI binary is published for ${platform}/${arch}.`)
  }
  const name = `kiln-${release.tag_name}-${os}-${arch}${os === "windows" ? ".exe" : ""}`
  const asset = release.assets.find((candidate) => candidate.name === name)
  if (!asset)
    throw new Error(
      `Release ${release.tag_name} does not have ${name} yet. Try again after its CLI build finishes.`
    )
  if (!asset.digest || !/^sha256:[a-f\d]{64}$/u.test(asset.digest)) {
    throw new Error(
      "GitHub did not provide a SHA-256 digest for the CLI binary."
    )
  }
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maximumBinarySize
  ) {
    throw new Error("The CLI binary has an invalid download size.")
  }
  const expectedUrl = `${repository}/releases/download/${release.tag_name}/${name}`
  if (asset.browser_download_url !== expectedUrl) {
    throw new Error(
      "The CLI asset does not belong to this distribution's release."
    )
  }
  return asset
}

const downloadBinary = Effect.fn("cli.update.downloadBinary")(function* (
  asset: Asset,
  destination: string
) {
  yield* Effect.acquireUseRelease(
    updateOperation(() => open(destination, "wx", 0o700)),
    (file) =>
      updateOperation(async (signal) => {
        const downloadSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(300_000),
        ])
        const response = await fetch(asset.browser_download_url, {
          signal: downloadSignal,
        })
        if (!response.ok || !response.body)
          throw new Error(`CLI download failed (HTTP ${response.status}).`)
        const digest = createHash("sha256")
        let bytes = 0
        for await (const chunk of response.body) {
          downloadSignal.throwIfAborted()
          bytes += chunk.byteLength
          if (bytes > asset.size)
            throw new Error("CLI download exceeded its expected size.")
          digest.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) {
            const result = await file.write(
              chunk,
              offset,
              chunk.byteLength - offset
            )
            if (!result.bytesWritten)
              throw new Error("CLI download write stalled.")
            offset += result.bytesWritten
          }
        }
        if (
          bytes !== asset.size ||
          `sha256:${digest.digest("hex")}` !== asset.digest
        ) {
          throw new Error(
            "CLI download failed its SHA-256 or size check; the installed binary was not changed."
          )
        }
        await file.sync()
      }),
    (file) => updateOperation(() => file.close())
  )
})

const replaceBinary = Effect.fn("cli.update.replaceBinary")(
  function* (staged: string, target: string, platform: NodeJS.Platform) {
    if (platform !== "win32") {
      yield* updateOperation(() => rename(staged, target))
      return
    }
    // Windows can move the running image aside, but cannot overwrite/delete it.
    // Keep it until the next update, when the previous process has exited.
    const backup = `${target}.old`
    yield* updateOperation(() => rm(backup, { force: true }))
    yield* updateOperation(() => rename(target, backup))
    yield* updateOperation(() => rename(staged, target)).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* updateOperation(() => rename(backup, target))
          return yield* cause
        })
      )
    )
  },
  // Cancellation must not leave the Windows two-rename transaction halfway through.
  Effect.uninterruptible
)

function isStandaloneCliBinary(entrypointPath: string): boolean {
  const normalizedPath = entrypointPath.replaceAll("\\", "/").toLowerCase()
  return (
    normalizedPath.startsWith("/$bunfs/") ||
    normalizedPath.startsWith("b:/~bun/")
  )
}

async function verifyBinary(
  path: string,
  version: string,
  signal: AbortSignal
) {
  const { stdout } = await execFileAsync(path, ["--version"], {
    signal,
    timeout: 15_000,
    windowsHide: true,
  })
  if (stdout.trim() !== `kiln ${version}`) {
    throw new Error("The downloaded binary reports an unexpected version.")
  }
}
