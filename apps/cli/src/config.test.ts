import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"

import {
  CredentialManagers,
  resolveSessionEffect,
  saveSessionEffect,
} from "./config.js"
import type { CredentialManager } from "./credential-store.js"

let directory = ""
let path = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-cli-config-test-"))
  path = join(directory, "config.json")
  vi.stubEnv("KILN_CONFIG", path)
  // Keep the developer's own session out of the tests.
  vi.stubEnv("KILN_TOKEN", "")
  vi.stubEnv("KILN_URL", "")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { force: true, recursive: true })
})

function run<A, E>(
  effect: Effect.Effect<A, E>,
  managers: ReadonlyArray<CredentialManager>
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(CredentialManagers, managers))
  )
}

describe("CLI credential persistence", () => {
  it("stores profile secrets outside the config file", async () => {
    const manager = memoryCredentialManager()
    const saved = await run(
      saveSessionEffect({
        profile: "workstation",
        token: "kiln_cli_external_secret",
        url: "https://kiln.example.test",
      }),
      [manager]
    )

    assert.isTrue(saved.protected)
    assert.strictEqual(saved.credentialManager, manager.id)
    const encoded = await readFile(path, "utf8")
    assert.notInclude(encoded, "kiln_cli_external_secret")
    assert.include(encoded, '"kind": "external"')
    assert.include(encoded, `"manager": "${manager.id}"`)

    const session = await run(resolveSessionEffect({}), [manager])
    assert.strictEqual(session.token, "kiln_cli_external_secret")
    assert.strictEqual(session.profile, "workstation")
  })

  it("does not write a file fallback when credential storage is interrupted", async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let storeSignal: AbortSignal | undefined
    const interrupted: CredentialManager = {
      id: "interrupted",
      label: "Interrupted manager",
      deletePassword: async () => false,
      getPassword: async () => null,
      setPassword: async (_account, _password, signal) => {
        storeSignal = signal
        markStarted()
        await new Promise<never>((_resolvePromise, rejectPromise) => {
          if (signal?.aborted) {
            rejectPromise(signal.reason)
            return
          }
          signal?.addEventListener(
            "abort",
            () => rejectPromise(signal.reason),
            { once: true }
          )
        })
      },
    }
    const fiber = Effect.runFork(
      saveSessionEffect({
        profile: "interrupted",
        token: "kiln_cli_interrupted_secret",
        url: "https://kiln.example.test",
      }).pipe(Effect.provideService(CredentialManagers, [interrupted]))
    )
    await started
    await Effect.runPromise(Fiber.interrupt(fiber))

    assert.isTrue(storeSignal?.aborted ?? false)
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("uses an owner-only file fallback during explicit session save", async () => {
    const saved = await run(
      saveSessionEffect({
        profile: "fallback",
        token: "kiln_cli_file_secret",
        url: "https://kiln.example.test",
      }),
      [failingCredentialManager()]
    )

    assert.isFalse(saved.protected)
    assert.strictEqual(saved.fallbackReason, "manager-failed")
    assert.strictEqual(saved.credentialManagerLabel, "Failing manager")
    const encoded = await readFile(path, "utf8")
    assert.include(encoded, "kiln_cli_file_secret")
    assert.include(encoded, '"kind": "file"')
    assert.strictEqual((await stat(path)).mode & 0o777, 0o600)
  })
})

function memoryCredentialManager(): CredentialManager & {
  passwords: Map<string, string>
} {
  const passwords = new Map<string, string>()
  return {
    id: "memory-v1",
    label: "Memory credential manager",
    passwords,
    deletePassword: async (account) => passwords.delete(account),
    getPassword: async (account) => passwords.get(account) ?? null,
    setPassword: async (account, password) => {
      passwords.set(account, password)
    },
  }
}

function failingCredentialManager(): CredentialManager {
  return {
    id: "failing",
    label: "Failing manager",
    deletePassword: async () => false,
    getPassword: async () => null,
    setPassword: async () => {
      throw new Error("unavailable")
    },
  }
}
