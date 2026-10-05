import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, join, parse, resolve } from "node:path"

import { Effect, Result } from "effect"

import { cliPackageName, cliReleasesUrl } from "./distribution.js"

import { commandError } from "./errors.js"
import { writeLine } from "./output.js"

export type CliPackageManager = "bun" | "npm" | "pnpm"

export interface CliUpdateCommand {
  arguments: ReadonlyArray<string>
  executable: string
  packageManager: CliPackageManager
}

export type CliUpdateRunner = (
  command: CliUpdateCommand,
  signal: AbortSignal
) => Promise<void>

interface DetectionFileSystem {
  exists(path: string): boolean
  realpath(path: string): string
}

export interface CliPackageManagerDetection {
  entrypointPath?: string
  environment?: NodeJS.ProcessEnv
  filesystem?: DetectionFileSystem
}

export interface CliUpdateOptions {
  detectPackageManager?: () => CliPackageManager
  isStandaloneBinary?: () => boolean
  platform?: NodeJS.Platform
  reportFallback?: (packageManager: Exclude<CliPackageManager, "npm">) => void
  runUpdate?: CliUpdateRunner
}

const nodeFileSystem: DetectionFileSystem = {
  exists: existsSync,
  realpath: (path) => realpathSync(path),
}

export const updateCliEffect = Effect.fn("cli.update")(function* (
  options: CliUpdateOptions = {}
) {
  const isStandaloneBinary =
    options.isStandaloneBinary ?? (() => isStandaloneCliBinary())
  if (yield* Effect.sync(isStandaloneBinary)) {
    return yield* commandError({
      code: "cli_update_standalone",
      message: `This Kiln CLI is a standalone binary, so it cannot update itself. Download a newer release from ${cliReleasesUrl()} and replace ${process.execPath}.`,
    })
  }

  const detectPackageManager =
    options.detectPackageManager ?? detectCliPackageManager
  const packageManager = yield* Effect.sync(() =>
    detectPackageManagerOrNpm(detectPackageManager)
  )
  const platform = options.platform ?? process.platform
  const reportFallback = options.reportFallback ?? writeFallbackMessage
  const runUpdate = options.runUpdate ?? runCliUpdate

  if (packageManager === "npm") {
    yield* runUpdateEffect(cliUpdateCommand("npm", platform), runUpdate)
    return
  }

  yield* runUpdateEffect(
    cliUpdateCommand(packageManager, platform),
    runUpdate
  ).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* Effect.sync(() => reportFallback(packageManager))
        yield* runUpdateEffect(cliUpdateCommand("npm", platform), runUpdate)
      })
    )
  )
})

export function detectCliPackageManager(
  options: CliPackageManagerDetection = {}
): CliPackageManager {
  const entrypointPath =
    options.entrypointPath ?? process.argv[1] ?? process.execPath
  const environment = options.environment ?? process.env
  const filesystem = options.filesystem ?? nodeFileSystem
  const packageRoot = dirname(resolve(entrypointPath))

  if (isPnpmManagedInstall(packageRoot, filesystem)) return "pnpm"
  if (isBunManagedInstall(entrypointPath, environment)) return "bun"
  return "npm"
}

// `bun build --compile` serves the bundled entrypoint from its embedded
// filesystem: /$bunfs/root/ on Unix and B:\~BUN\root\ on Windows.
export function isStandaloneCliBinary(
  entrypointPath: string = process.argv[1] ?? ""
): boolean {
  const normalizedPath = entrypointPath.replaceAll("\\", "/").toLowerCase()
  return (
    normalizedPath.startsWith("/$bunfs/") ||
    normalizedPath.startsWith("b:/~bun/")
  )
}

export function cliUpdateCommand(
  packageManager: CliPackageManager,
  platform: NodeJS.Platform = process.platform
): CliUpdateCommand {
  const arguments_ = updateArguments(packageManager)
  if (platform === "win32") {
    return {
      arguments: [
        "/d",
        "/s",
        "/c",
        `${packageManager} ${arguments_.join(" ")}`,
      ],
      executable: "cmd.exe",
      packageManager,
    }
  }
  return {
    arguments: arguments_,
    executable: packageManager,
    packageManager,
  }
}

function updateArguments(
  packageManager: CliPackageManager
): ReadonlyArray<string> {
  if (packageManager === "pnpm") {
    return ["add", "--global", `${cliPackageName}@latest`]
  }
  return ["install", "--global", `${cliPackageName}@latest`]
}

function detectPackageManagerOrNpm(
  detectPackageManager: () => CliPackageManager
): CliPackageManager {
  return Result.try(detectPackageManager).pipe(
    Result.getOrElse((): CliPackageManager => "npm")
  )
}

function isPnpmManagedInstall(
  packageRoot: string,
  filesystem: DetectionFileSystem
): boolean {
  const canonicalPackageRoot = canonicalPath(packageRoot, filesystem)
  return [packageRoot, canonicalPackageRoot].some((startPath) =>
    ancestorOwnsPnpmPackage(startPath, canonicalPackageRoot, filesystem)
  )
}

function ancestorOwnsPnpmPackage(
  startPath: string,
  canonicalPackageRoot: string,
  filesystem: DetectionFileSystem
): boolean {
  let currentPath = resolve(startPath)
  const rootPath = parse(currentPath).root

  while (true) {
    const nodeModulesPath = join(currentPath, "node_modules")
    if (
      filesystem.exists(join(nodeModulesPath, ".modules.yaml")) &&
      canonicalPath(join(nodeModulesPath, cliPackageName), filesystem) ===
        canonicalPackageRoot
    ) {
      return true
    }
    if (currentPath === rootPath) return false
    currentPath = dirname(currentPath)
  }
}

function canonicalPath(path: string, filesystem: DetectionFileSystem): string {
  return Result.try(() => resolve(filesystem.realpath(path))).pipe(
    Result.getOrElse(() => resolve(path))
  )
}

function isBunManagedInstall(
  entrypointPath: string,
  environment: NodeJS.ProcessEnv
): boolean {
  const normalizedPath = entrypointPath.replaceAll("\\", "/").toLowerCase()
  const userAgent = environment.npm_config_user_agent?.toLowerCase()
  const npmExecPath = environment.npm_execpath
  return (
    userAgent?.startsWith("bun/") === true ||
    (npmExecPath !== undefined &&
      basename(npmExecPath).toLowerCase().startsWith("bun")) ||
    normalizedPath.includes("/.bun/install/global/")
  )
}

function runUpdateEffect(
  command: CliUpdateCommand,
  runUpdate: CliUpdateRunner
) {
  return Effect.tryPromise({
    try: (signal) => runUpdate(command, signal),
    catch: (cause) =>
      commandError({
        cause,
        code: "cli_update_failed",
        message: `${command.packageManager} could not update the Kiln CLI.`,
      }),
  })
}

function writeFallbackMessage(
  packageManager: Exclude<CliPackageManager, "npm">
): void {
  writeLine(
    `${packageManager} could not update the Kiln CLI; retrying with npm.`
  )
}

function runCliUpdate(
  command: CliUpdateCommand,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.arguments, {
      signal,
      stdio: "inherit",
    })
    child.once("error", rejectPromise)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new Error(
          signal
            ? `${command.packageManager} was terminated by ${signal}.`
            : `${command.packageManager} exited with code ${code ?? "unknown"}.`
        )
      )
    })
  })
}
