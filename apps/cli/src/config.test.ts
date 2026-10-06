import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"

import {
  CredentialManagers,
  resolveLoginTargetEffect,
  removeSessionEffect,
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

async function readConfig() {
  return JSON.parse(await readFile(path, "utf8"))
}

async function writeConfig(config: unknown) {
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 })
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

  it("migrates version 1 plaintext profiles into the credential manager", async () => {
    await writeConfig({
      activeProfile: "legacy",
      profiles: {
        legacy: {
          token: "kiln_cli_legacy_secret",
          url: "https://kiln.example.test",
        },
      },
      version: 1,
    })
    const manager = memoryCredentialManager()

    const session = await run(resolveSessionEffect({}), [manager])

    assert.strictEqual(session.token, "kiln_cli_legacy_secret")
    assert.strictEqual((await readConfig()).version, 2)
    const encoded = await readFile(path, "utf8")
    assert.notInclude(encoded, "kiln_cli_legacy_secret")
    assert.include(encoded, '"kind": "external"')
    assert.deepStrictEqual(
      [...manager.passwords.values()],
      ["kiln_cli_legacy_secret"]
    )
  })

  it("keeps version 1 intact when native credential migration fails", async () => {
    const legacy = {
      activeProfile: "legacy",
      profiles: {
        legacy: {
          token: "kiln_cli_retry_secret",
          url: "https://kiln.example.test",
        },
      },
      version: 1,
    } as const
    await writeConfig(legacy)

    const session = await run(resolveSessionEffect({}), [
      failingCredentialManager(),
    ])

    assert.strictEqual(session.token, "kiln_cli_retry_secret")
    assert.deepStrictEqual(await readConfig(), legacy)

    const recovered = memoryCredentialManager()
    await run(resolveSessionEffect({}), [recovered])
    assert.strictEqual((await readConfig()).version, 2)
    assert.notInclude(await readFile(path, "utf8"), "retry_secret")
    assert.deepStrictEqual(
      [...recovered.passwords.values()],
      ["kiln_cli_retry_secret"]
    )
  })

  it("migrates to the file fallback when no native manager exists", async () => {
    await writeConfig({
      activeProfile: "headless",
      profiles: {
        headless: {
          token: "kiln_cli_headless_secret",
          url: "https://kiln.example.test",
        },
      },
      version: 1,
    })

    const session = await run(resolveSessionEffect({}), [])
    const config = await readConfig()

    assert.strictEqual(session.token, "kiln_cli_headless_secret")
    assert.strictEqual(config.version, 2)
    assert.deepStrictEqual(config.profiles.headless?.credential, {
      kind: "file",
      token: "kiln_cli_headless_secret",
    })
    assert.strictEqual((await stat(path)).mode & 0o777, 0o600)
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

  it("reports when no native credential manager is available", async () => {
    const saved = await run(
      saveSessionEffect({
        profile: "headless",
        token: "kiln_cli_headless_login_secret",
        url: "https://kiln.example.test",
      }),
      []
    )

    assert.isFalse(saved.protected)
    assert.strictEqual(saved.fallbackReason, "manager-unavailable")
  })

  it("bypasses legacy migration for explicit token sources", async () => {
    const legacy = {
      activeProfile: "legacy",
      profiles: {
        legacy: {
          token: "kiln_cli_stored_secret",
          url: "https://kiln.example.test",
        },
      },
      version: 1,
    } as const
    await writeConfig(legacy)
    const manager = memoryCredentialManager()

    const fromFlag = await run(
      resolveSessionEffect({ token: "kiln_cli_flag_secret" }),
      [manager]
    )
    vi.stubEnv("KILN_TOKEN", "kiln_cli_environment_secret")
    const fromEnvironment = await run(resolveSessionEffect({}), [manager])

    assert.strictEqual(fromFlag.token, "kiln_cli_flag_secret")
    assert.strictEqual(fromEnvironment.token, "kiln_cli_environment_secret")
    assert.strictEqual(manager.passwords.size, 0)
    assert.deepStrictEqual(await readConfig(), legacy)
  })

  it("stores a new login without first migrating the replaced token", async () => {
    await writeConfig({
      activeProfile: "replace",
      profiles: {
        replace: {
          token: "kiln_cli_old_login_secret",
          url: "https://old.example.test",
        },
      },
      version: 1,
    })
    const manager = memoryCredentialManager()

    const saved = await run(
      saveSessionEffect({
        profile: "replace",
        token: "kiln_cli_new_login_secret",
        url: "https://new.example.test",
      }),
      [manager]
    )
    const encoded = await readFile(path, "utf8")

    assert.isTrue(saved.protected)
    assert.deepStrictEqual(
      [...manager.passwords.values()],
      ["kiln_cli_new_login_secret"]
    )
    assert.notInclude(encoded, "old_login_secret")
    assert.notInclude(encoded, "new_login_secret")
  })

  it("replaces a legacy profile without migrating its old credential", async () => {
    await writeConfig({
      activeProfile: "replace",
      profiles: {
        keep: {
          token: "kiln_cli_keep_secret",
          url: "https://keep.example.test",
        },
        replace: {
          token: "kiln_cli_old_secret",
          url: "https://old.example.test",
        },
      },
      version: 1,
    })

    const saved = await run(
      saveSessionEffect({
        profile: "replace",
        token: "kiln_cli_new_secret",
        url: "https://new.example.test",
      }),
      [failingCredentialManager()]
    )
    const config = await readConfig()

    assert.strictEqual(saved.fallbackReason, "manager-failed")
    assert.strictEqual(config.version, 1)
    assert.deepStrictEqual(config.profiles.replace, {
      token: "kiln_cli_new_secret",
      url: "https://new.example.test",
    })
    assert.deepStrictEqual(config.profiles.keep, {
      token: "kiln_cli_keep_secret",
      url: "https://keep.example.test",
    })
    assert.notInclude(await readFile(path, "utf8"), "old_secret")

    const recovered = memoryCredentialManager()
    const session = await run(resolveSessionEffect({ profile: "keep" }), [
      recovered,
    ])
    const migrated = await readConfig()

    assert.strictEqual(session.token, "kiln_cli_keep_secret")
    assert.strictEqual(migrated.version, 2)
    assert.strictEqual(migrated.profiles.keep?.credential.kind, "external")
    assert.deepStrictEqual(migrated.profiles.replace?.credential, {
      kind: "legacy-file",
      token: "kiln_cli_new_secret",
    })
    assert.notInclude(await readFile(path, "utf8"), "kiln_cli_keep_secret")
  })

  it("removes a legacy profile without migrating any credential", async () => {
    await writeConfig({
      activeProfile: "remove",
      profiles: {
        keep: {
          token: "kiln_cli_keep_secret",
          url: "https://keep.example.test",
        },
        remove: {
          token: "kiln_cli_remove_secret",
          url: "https://remove.example.test",
        },
      },
      version: 1,
    })
    const manager = memoryCredentialManager()

    const session = await run(
      resolveSessionEffect({ migrateStoredCredential: false }),
      [manager]
    )
    const removed = await run(removeSessionEffect("remove"), [manager])
    const config = await readConfig()

    assert.strictEqual(session.token, "kiln_cli_remove_secret")
    assert.isTrue(removed.removed)
    assert.strictEqual(manager.passwords.size, 0)
    assert.strictEqual(config.version, 1)
    assert.isUndefined(config.profiles.remove)
    assert.deepStrictEqual(config.profiles.keep, {
      token: "kiln_cli_keep_secret",
      url: "https://keep.example.test",
    })
  })

  it("removes both profile metadata and its external credential", async () => {
    const manager = memoryCredentialManager()
    await run(
      saveSessionEffect({
        profile: "delete-me",
        token: "kiln_cli_delete_secret",
        url: "https://kiln.example.test",
      }),
      [manager]
    )
    assert.strictEqual(manager.passwords.size, 1)

    const removed = await run(removeSessionEffect("delete-me"), [manager])

    assert.isTrue(removed.removed)
    assert.isTrue(removed.credentialRemoved)
    assert.strictEqual(manager.passwords.size, 0)
    assert.notInclude(await readFile(path, "utf8"), "delete-me")
  })
})

it("login uses the selected profile and honors KILN_URL and an explicit URL", async () => {
  const managers = [memoryCredentialManager()]
  await run(
    saveSessionEffect({
      profile: "fork",
      token: "kiln_cli_test",
      url: "https://fork.example.com",
    }),
    managers
  )
  expect(await run(resolveLoginTargetEffect({}), managers)).toEqual({
    profile: "fork",
    url: "https://fork.example.com",
  })

  vi.stubEnv("KILN_URL", "https://env.example.com")
  expect((await run(resolveLoginTargetEffect({}), managers)).url).toBe(
    "https://env.example.com"
  )
  expect(
    (
      await run(
        resolveLoginTargetEffect({ url: "https://explicit.example.com" }),
        managers
      )
    ).url
  ).toBe("https://explicit.example.com")
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
