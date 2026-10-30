import { assert, describe, it } from "@effect/vitest"

import {
  credentialManagersForPlatform,
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
  }
})
