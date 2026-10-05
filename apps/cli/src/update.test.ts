import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { join, resolve } from "node:path"

import {
  cliUpdateCommand,
  detectCliPackageManager,
  isStandaloneCliBinary,
  updateCliEffect,
  type CliUpdateCommand,
} from "./update.js"

describe("CLI update", () => {
  it.effect("uses the package manager that owns the CLI installation", () =>
    Effect.gen(function* () {
      const received: Array<CliUpdateCommand> = []

      yield* updateCliEffect({
        detectPackageManager: () => "pnpm",
        runUpdate: async (command) => {
          received.push(command)
        },
      })

      assert.deepStrictEqual(received, [
        {
          arguments: ["add", "--global", "kiln-cli@latest"],
          executable: "pnpm",
          packageManager: "pnpm",
        },
      ])
    })
  )

  it.effect("falls back to npm when pnpm or Bun cannot update", () =>
    Effect.gen(function* () {
      const received: Array<CliUpdateCommand> = []
      const fallbacks: Array<string> = []

      yield* updateCliEffect({
        detectPackageManager: () => "bun",
        reportFallback: (packageManager) => {
          fallbacks.push(packageManager)
        },
        runUpdate: async (command) => {
          received.push(command)
          if (command.packageManager === "bun") {
            throw new Error("bun update failed")
          }
        },
      })

      assert.deepStrictEqual(
        received.map((command) => command.packageManager),
        ["bun", "npm"]
      )
      assert.deepStrictEqual(fallbacks, ["bun"])
    })
  )

  it.effect("defaults to npm when package manager detection fails", () =>
    Effect.gen(function* () {
      const received: Array<CliUpdateCommand> = []

      yield* updateCliEffect({
        detectPackageManager: () => {
          throw new Error("detection failed")
        },
        runUpdate: async (command) => {
          received.push(command)
        },
      })

      assert.strictEqual(received[0]?.packageManager, "npm")
    })
  )

  it.effect("reports npm failures as CLI update errors", () =>
    Effect.gen(function* () {
      const failure = yield* updateCliEffect({
        detectPackageManager: () => "npm",
        runUpdate: async () => {
          throw new Error("permission denied")
        },
      }).pipe(Effect.flip)

      assert.strictEqual(failure.code, "cli_update_failed")
      assert.strictEqual(failure.message, "npm could not update the Kiln CLI.")
    })
  )

  it.effect("points standalone binaries at GitHub releases", () =>
    Effect.gen(function* () {
      const received: Array<CliUpdateCommand> = []

      const failure = yield* updateCliEffect({
        isStandaloneBinary: () => true,
        runUpdate: async (command) => {
          received.push(command)
        },
      }).pipe(Effect.flip)

      assert.deepStrictEqual(received, [])
      assert.strictEqual(failure.code, "cli_update_standalone")
      assert.include(
        failure.message,
        "https://github.com/kiln-site/kiln/releases"
      )
    })
  )

  it("detects standalone binaries by Bun's embedded entrypoint", () => {
    assert.isTrue(isStandaloneCliBinary("/$bunfs/root/kiln"))
    assert.isTrue(isStandaloneCliBinary("B:\\~BUN\\root\\kiln.exe"))
    assert.isFalse(
      isStandaloneCliBinary("/usr/local/lib/node_modules/kiln-cli/kiln.mjs")
    )
  })

  it("detects a pnpm-owned global installation", () => {
    const globalRoot = resolve("test-global")
    const packageRoot = join(globalRoot, "node_modules", "kiln-cli")
    const canonicalPackageRoot = join(
      globalRoot,
      "node_modules",
      ".pnpm",
      "kiln-cli@1.2.3",
      "node_modules",
      "kiln-cli"
    )
    const modulesManifest = join(globalRoot, "node_modules", ".modules.yaml")

    assert.strictEqual(
      detectCliPackageManager({
        entrypointPath: join(packageRoot, "kiln.mjs"),
        environment: {},
        filesystem: {
          exists: (path) => path === modulesManifest,
          realpath: (path) => {
            if (path === packageRoot) return canonicalPackageRoot
            return path
          },
        },
      }),
      "pnpm"
    )
  })

  it("detects a Bun global installation", () => {
    assert.strictEqual(
      detectCliPackageManager({
        entrypointPath: join(
          resolve("test-home"),
          ".bun",
          "install",
          "global",
          "node_modules",
          "kiln-cli",
          "kiln.mjs"
        ),
        environment: {},
        filesystem: {
          exists: () => false,
          realpath: (path) => path,
        },
      }),
      "bun"
    )
  })

  it("builds direct npm, pnpm, and Bun commands", () => {
    assert.deepStrictEqual(cliUpdateCommand("npm", "linux"), {
      arguments: ["install", "--global", "kiln-cli@latest"],
      executable: "npm",
      packageManager: "npm",
    })
    assert.deepStrictEqual(cliUpdateCommand("pnpm", "linux"), {
      arguments: ["add", "--global", "kiln-cli@latest"],
      executable: "pnpm",
      packageManager: "pnpm",
    })
    assert.deepStrictEqual(cliUpdateCommand("bun", "linux"), {
      arguments: ["install", "--global", "kiln-cli@latest"],
      executable: "bun",
      packageManager: "bun",
    })
  })

  it("uses cmd.exe for Windows package manager commands", () => {
    assert.deepStrictEqual(cliUpdateCommand("npm", "win32"), {
      arguments: ["/d", "/s", "/c", "npm install --global kiln-cli@latest"],
      executable: "cmd.exe",
      packageManager: "npm",
    })
    assert.deepStrictEqual(cliUpdateCommand("pnpm", "win32"), {
      arguments: ["/d", "/s", "/c", "pnpm add --global kiln-cli@latest"],
      executable: "cmd.exe",
      packageManager: "pnpm",
    })
  })
})
