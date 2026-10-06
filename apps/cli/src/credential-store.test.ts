import { assert, describe, it } from "@effect/vitest"

import {
  credentialManagersForPlatform,
  macosKeychainCredentialManager,
  runCredentialCommand,
  windowsCredentialManager,
  type CredentialCommand,
  type CredentialCommandResult,
} from "./credential-store.js"

const success = (stdout = ""): CredentialCommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
})

describe("CLI credential managers", () => {
  it("selects only the native manager for supported desktop platforms", () => {
    assert.deepStrictEqual(
      credentialManagersForPlatform("darwin", async () => success()).map(
        (manager) => manager.id
      ),
      ["macos-keychain-v1"]
    )
    assert.deepStrictEqual(
      credentialManagersForPlatform("win32", async () => success()).map(
        (manager) => manager.id
      ),
      ["windows-credential-manager-v1"]
    )
    assert.deepStrictEqual(
      credentialManagersForPlatform("linux", async () => success()),
      []
    )
  })

  it("passes macOS secrets through stdin instead of process arguments", async () => {
    const commands: Array<CredentialCommand> = []
    const manager = macosKeychainCredentialManager(async (command) => {
      commands.push(command)
      return success()
    })

    await manager.setPassword("profile-account", "kiln_cli_secret")

    assert.strictEqual(commands.length, 1)
    assert.strictEqual(commands[0]?.executable, "/usr/bin/osascript")
    assert.notInclude(commands[0]?.arguments, "kiln_cli_secret")
    assert.notInclude(commands[0]?.arguments, "profile-account")
    assert.deepStrictEqual(commands[0]?.arguments.slice(0, 3), [
      "-l",
      "JavaScript",
      "-e",
    ])
    assert.deepStrictEqual(JSON.parse(commands[0]?.input ?? ""), {
      account: "profile-account",
      operation: "set",
      password: "kiln_cli_secret",
      service: "site.kiln.cli",
    })
  })

  it("reads and deletes macOS Keychain credentials", async () => {
    const commands: Array<CredentialCommand> = []
    const results = [
      success('{"password":"kiln_cli_secret"}\n'),
      success('{"deleted":true}\n'),
    ]
    const manager = macosKeychainCredentialManager(async (command) => {
      commands.push(command)
      return results.shift() ?? success()
    })

    assert.strictEqual(
      await manager.getPassword("profile-account"),
      "kiln_cli_secret"
    )
    assert.isTrue(await manager.deletePassword("profile-account"))
    assert.strictEqual(JSON.parse(commands[0]?.input ?? "").operation, "get")
    assert.strictEqual(JSON.parse(commands[1]?.input ?? "").operation, "delete")
  })

  it("treats missing native credentials as absent", async () => {
    const missing = async (): Promise<CredentialCommandResult> => ({
      exitCode: 44,
      stderr: "not found",
      stdout: "",
    })

    assert.isNull(
      await macosKeychainCredentialManager(async () =>
        success('{"password":null}\n')
      ).getPassword("missing")
    )
    assert.isFalse(
      await windowsCredentialManager(missing).deletePassword("missing")
    )
  })

  it("passes Windows secrets through stdin instead of process arguments", async () => {
    const commands: Array<CredentialCommand> = []
    const manager = windowsCredentialManager(async (command) => {
      commands.push(command)
      return success()
    })

    await manager.setPassword("profile-account", "kiln_cli_secret")

    assert.strictEqual(commands.length, 1)
    assert.match(
      commands[0]?.executable ?? "",
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u
    )
    assert.notInclude(commands[0]?.arguments, "kiln_cli_secret")
    assert.notInclude(commands[0]?.arguments, "site.kiln.cli:profile-account")
    assert.deepStrictEqual(JSON.parse(commands[0]?.input ?? ""), {
      account: "profile-account",
      password: "kiln_cli_secret",
      target: "site.kiln.cli:profile-account",
    })
  })

  it("waits for inherited command output to close", async () => {
    const delayedOutput = [
      `const { spawn } = require("node:child_process")`,
      `const child = spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('complete'), 25)"], { stdio: ["ignore", process.stdout, "ignore"] })`,
      `child.unref()`,
    ].join(";")

    const result = await runCredentialCommand({
      arguments: ["-e", delayedOutput],
      executable: process.execPath,
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, "complete")
  })

  it("passes command input through stdin without user interaction", async () => {
    const readInput = [
      `process.stdin.setEncoding("utf8")`,
      `let input = ""`,
      `process.stdin.on("data", (chunk) => { input += chunk })`,
      `process.stdin.on("end", () => process.stdout.write(String(input.length)))`,
    ].join(";")

    const result = await runCredentialCommand({
      arguments: ["-e", readInput],
      executable: process.execPath,
      input: "credential-data",
    })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(result.stdout, "15")
  })
})
