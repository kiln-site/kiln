import { assert, describe, it } from "@effect/vitest"

import {
  credentialManagersForPlatform,
  runCredentialCommand,
  type CredentialCommand,
  type CredentialCommandResult,
  type CredentialManager,
} from "./credential-store.js"

const result = (exitCode: number, stdout = ""): CredentialCommandResult => ({
  exitCode,
  stderr: "",
  stdout,
})

// Stateful stand-in for the OS credential store at the child-process boundary.
function fakeCredentialStore(platform: "darwin" | "win32") {
  const entries = new Map<string, string>()
  const commands: Array<CredentialCommand> = []
  const run = async (
    command: CredentialCommand
  ): Promise<CredentialCommandResult> => {
    commands.push(command)
    const input = JSON.parse(command.input ?? "{}")
    if (platform === "darwin") {
      const key = `${input.service}:${input.account}`
      if (input.operation === "set") {
        entries.set(key, input.password)
        return result(0, '{"stored":true}\n')
      }
      if (input.operation === "get") {
        return result(
          0,
          `${JSON.stringify({ password: entries.get(key) ?? null })}\n`
        )
      }
      return result(0, `${JSON.stringify({ deleted: entries.delete(key) })}\n`)
    }
    const script = command.arguments.at(-1) ?? ""
    if (script.includes("::CredWrite(")) {
      entries.set(input.target, input.password)
      return result(0)
    }
    if (script.includes("::CredRead(")) {
      const password = entries.get(input.target)
      return password === undefined ? result(44) : result(0, password)
    }
    return entries.delete(input.target) ? result(0) : result(44)
  }
  const [manager] = credentialManagersForPlatform(platform, run)
  return { commands, manager: manager as CredentialManager }
}

describe("CLI credential managers", () => {
  it("keeps the manager ids that saved configs reference", () => {
    const run = async () => result(0)
    assert.deepStrictEqual(
      credentialManagersForPlatform("darwin", run).map(({ id }) => id),
      ["macos-keychain-v1"]
    )
    assert.deepStrictEqual(
      credentialManagersForPlatform("win32", run).map(({ id }) => id),
      ["windows-credential-manager-v1"]
    )
    assert.deepStrictEqual(credentialManagersForPlatform("linux", run), [])
  })

  for (const platform of ["darwin", "win32"] as const) {
    it(`${platform}: passes secrets through stdin instead of process arguments`, async () => {
      const { commands, manager } = fakeCredentialStore(platform)

      await manager.setPassword("profile-account", "kiln_cli_secret")

      assert.strictEqual(commands.length, 1)
      const [command] = commands
      // An absolute system path cannot be hijacked through PATH.
      assert.match(
        command?.executable ?? "",
        platform === "darwin"
          ? /^\/usr\/bin\/osascript$/u
          : /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u
      )
      for (const argument of command?.arguments ?? []) {
        assert.notInclude(argument, "kiln_cli_secret")
        assert.notInclude(argument, "profile-account")
      }
      assert.include(command?.input ?? "", "kiln_cli_secret")
    })

    it(`${platform}: stores, reads, and deletes credentials and treats missing ones as absent`, async () => {
      const { manager } = fakeCredentialStore(platform)

      assert.isNull(await manager.getPassword("profile-account"))
      await manager.setPassword("profile-account", "kiln_cli_secret")
      assert.strictEqual(
        await manager.getPassword("profile-account"),
        "kiln_cli_secret"
      )
      assert.isTrue(await manager.deletePassword("profile-account"))
      assert.isNull(await manager.getPassword("profile-account"))
      assert.isFalse(await manager.deletePassword("profile-account"))
    })

    it(`${platform}: fails instead of reporting success when the store errors`, async () => {
      const [manager] = credentialManagersForPlatform(platform, async () =>
        result(1)
      )
      if (!manager) throw new Error("Expected a native credential manager")

      for (const operation of [
        () => manager.setPassword("profile-account", "kiln_cli_secret"),
        () => manager.getPassword("profile-account"),
        () => manager.deletePassword("profile-account"),
      ]) {
        const outcome = await operation().then(
          () => "resolved",
          () => "rejected"
        )
        assert.strictEqual(outcome, "rejected")
      }
    })
  }

  it("waits for output from processes that outlive the command", async () => {
    // The helper writes only after the command's own process has exited and
    // been reaped, so resolving on "exit" instead of "close" loses the output.
    const lateWriter = [
      `const parent = Number(process.argv[1])`,
      `const alive = () => { try { process.kill(parent, 0); return true } catch { return false } }`,
      `const wait = () => alive() ? setTimeout(wait, 5) : process.stdout.write("complete")`,
      `wait()`,
    ].join(";")
    const command = [
      `const { spawn } = require("node:child_process")`,
      `spawn(process.execPath, ["-e", ${JSON.stringify(lateWriter)}, String(process.pid)], { stdio: ["ignore", process.stdout, "ignore"] }).unref()`,
    ].join(";")

    const output = await runCredentialCommand({
      arguments: ["-e", command],
      executable: process.execPath,
    })

    assert.strictEqual(output.exitCode, 0)
    assert.strictEqual(output.stdout, "complete")
  })

  it("passes command input through stdin without user interaction", async () => {
    const readInput = [
      `process.stdin.setEncoding("utf8")`,
      `let input = ""`,
      `process.stdin.on("data", (chunk) => { input += chunk })`,
      `process.stdin.on("end", () => process.stdout.write(input))`,
    ].join(";")

    const output = await runCredentialCommand({
      arguments: ["-e", readInput],
      executable: process.execPath,
      input: "credential-data",
    })

    assert.strictEqual(output.exitCode, 0)
    assert.strictEqual(output.stdout, "credential-data")
  })
})
