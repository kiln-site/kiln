import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"

import {
  loadConfigEffect,
  resolveLoginTargetEffect,
  removeSessionEffect,
  resolveSessionEffect,
  saveSessionEffect,
  type ConfigOptions,
} from "./config.js"
import type { CredentialManager } from "./credential-store.js"

describe("CLI credential persistence", () => {
  it("stores profile secrets outside the config file", async () => {
    const fixture = await configFixture()
    try {
      const manager = memoryCredentialManager()
      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "workstation",
            token: "kiln_cli_external_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([manager])
        )
      )

      assert.isTrue(saved.protected)
      assert.strictEqual(saved.credentialManager, manager.id)
      const encoded = await readFile(fixture.path, "utf8")
      assert.notInclude(encoded, "kiln_cli_external_secret")
      assert.include(encoded, '"kind": "external"')
      assert.include(encoded, `"manager": "${manager.id}"`)

      const session = await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([manager]))
      )
      assert.strictEqual(session.token, "kiln_cli_external_secret")
      assert.strictEqual(session.profile, "workstation")
    } finally {
      await fixture.cleanup()
    }
  })

  it("migrates version 1 plaintext profiles into the credential manager", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          activeProfile: "legacy",
          profiles: {
            legacy: {
              token: "kiln_cli_legacy_secret",
              url: "https://kiln.example.test",
            },
          },
          version: 1,
        })}\n`,
        { mode: 0o600 }
      )
      const manager = memoryCredentialManager()

      const before = await Effect.runPromise(
        loadConfigEffect(fixture.options([manager]))
      )
      assert.strictEqual(before.version, 1)
      assert.strictEqual(manager.passwords.size, 0)

      const session = await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([manager]))
      )
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([manager]))
      )

      assert.strictEqual(session.token, "kiln_cli_legacy_secret")
      assert.strictEqual(config.version, 2)
      const encoded = await readFile(fixture.path, "utf8")
      assert.notInclude(encoded, "kiln_cli_legacy_secret")
      assert.include(encoded, '"kind": "external"')
      assert.deepStrictEqual(
        [...manager.passwords.values()],
        ["kiln_cli_legacy_secret"]
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("keeps version 1 intact when native credential migration fails", async () => {
    const fixture = await configFixture()
    try {
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
      await writeFile(fixture.path, `${JSON.stringify(legacy)}\n`, {
        mode: 0o600,
      })
      const failing = failingCredentialManager()

      const session = await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([failing]))
      )

      assert.strictEqual(session.token, "kiln_cli_retry_secret")
      assert.strictEqual(failing.setCalls, 1)
      assert.deepStrictEqual(
        JSON.parse(await readFile(fixture.path, "utf8")),
        legacy
      )

      const recovered = memoryCredentialManager()
      await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([recovered]))
      )
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )
      assert.strictEqual(config.version, 2)
      assert.notInclude(await readFile(fixture.path, "utf8"), "retry_secret")
      assert.deepStrictEqual(
        [...recovered.passwords.values()],
        ["kiln_cli_retry_secret"]
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("migrates to the file fallback when no native manager exists", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          activeProfile: "headless",
          profiles: {
            headless: {
              token: "kiln_cli_headless_secret",
              url: "https://kiln.example.test",
            },
          },
          version: 1,
        })}\n`,
        { mode: 0o600 }
      )

      const session = await Effect.runPromise(
        resolveSessionEffect({}, fixture.options([]))
      )
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )

      assert.strictEqual(session.token, "kiln_cli_headless_secret")
      if (config.version !== 2) throw new Error("Expected version 2 config")
      assert.deepStrictEqual(config.profiles.headless?.credential, {
        kind: "file",
        token: "kiln_cli_headless_secret",
      })
      assert.strictEqual((await stat(fixture.path)).mode & 0o777, 0o600)
    } finally {
      await fixture.cleanup()
    }
  })

  it("does not write a file fallback when credential storage is interrupted", async () => {
    const fixture = await configFixture()
    let startedResolve: () => void = () => undefined
    const started = new Promise<void>((resolvePromise) => {
      startedResolve = resolvePromise
    })
    let storeSignal: AbortSignal | undefined
    const interrupted: CredentialManager = {
      id: "interrupted",
      label: "Interrupted manager",
      deletePassword: async () => false,
      getPassword: async () => null,
      setPassword: async (_account, _password, signal) => {
        storeSignal = signal
        startedResolve()
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
    try {
      const fiber = Effect.runFork(
        saveSessionEffect(
          {
            profile: "interrupted",
            token: "kiln_cli_interrupted_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([interrupted])
        )
      )
      await started
      await Effect.runPromise(Fiber.interrupt(fiber))

      assert.isTrue(storeSignal?.aborted ?? false)
      await expect(readFile(fixture.path, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it("uses an owner-only file fallback during explicit session save", async () => {
    const fixture = await configFixture()
    try {
      const failed: CredentialManager = {
        id: "failing",
        label: "Failing manager",
        deletePassword: async () => false,
        getPassword: async () => null,
        setPassword: async () => {
          throw new Error("unavailable")
        },
      }
      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "fallback",
            token: "kiln_cli_file_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([failed])
        )
      )

      assert.isFalse(saved.protected)
      assert.strictEqual(saved.fallbackReason, "manager-failed")
      assert.strictEqual(saved.credentialManagerLabel, "Failing manager")
      const encoded = await readFile(fixture.path, "utf8")
      assert.include(encoded, "kiln_cli_file_secret")
      assert.include(encoded, '"kind": "file"')
      assert.strictEqual((await stat(fixture.path)).mode & 0o777, 0o600)
    } finally {
      await fixture.cleanup()
    }
  })

  it("reports when no native credential manager is available", async () => {
    const fixture = await configFixture()
    try {
      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "headless",
            token: "kiln_cli_headless_login_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([])
        )
      )

      assert.isFalse(saved.protected)
      assert.strictEqual(saved.fallbackReason, "manager-unavailable")
      assert.strictEqual(saved.credentialManagerLabel, "the Kiln config file")
    } finally {
      await fixture.cleanup()
    }
  })

  it("bypasses legacy migration for explicit token sources", async () => {
    const fixture = await configFixture()
    try {
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
      await writeFile(fixture.path, `${JSON.stringify(legacy)}\n`, {
        mode: 0o600,
      })
      const manager = failingCredentialManager()

      const fromFlag = await Effect.runPromise(
        resolveSessionEffect(
          { token: "kiln_cli_flag_secret" },
          fixture.options([manager])
        )
      )
      const fromEnvironment = await Effect.runPromise(
        resolveSessionEffect(
          {},
          fixture.options([manager], {
            KILN_TOKEN: "kiln_cli_environment_secret",
          })
        )
      )

      assert.strictEqual(fromFlag.token, "kiln_cli_flag_secret")
      assert.strictEqual(fromEnvironment.token, "kiln_cli_environment_secret")
      assert.strictEqual(manager.setCalls, 0)
      assert.deepStrictEqual(
        JSON.parse(await readFile(fixture.path, "utf8")),
        legacy
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("stores a new login without first migrating the replaced token", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          activeProfile: "replace",
          profiles: {
            replace: {
              token: "kiln_cli_old_login_secret",
              url: "https://old.example.test",
            },
          },
          version: 1,
        })}\n`,
        { mode: 0o600 }
      )
      const manager = memoryCredentialManager()

      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "replace",
            token: "kiln_cli_new_login_secret",
            url: "https://new.example.test",
          },
          fixture.options([manager])
        )
      )
      const encoded = await readFile(fixture.path, "utf8")

      assert.isTrue(saved.protected)
      assert.deepStrictEqual(
        [...manager.passwords.values()],
        ["kiln_cli_new_login_secret"]
      )
      assert.notInclude(encoded, "old_login_secret")
      assert.notInclude(encoded, "new_login_secret")
    } finally {
      await fixture.cleanup()
    }
  })

  it("replaces a legacy profile without migrating its old credential", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
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
        })}\n`,
        { mode: 0o600 }
      )
      const manager = failingCredentialManager()

      const saved = await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "replace",
            token: "kiln_cli_new_secret",
            url: "https://new.example.test",
          },
          fixture.options([manager])
        )
      )
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )

      assert.strictEqual(saved.fallbackReason, "manager-failed")
      assert.strictEqual(manager.setCalls, 1)
      if (config.version !== 1) throw new Error("Expected version 1 config")
      assert.deepStrictEqual(config.profiles.replace, {
        token: "kiln_cli_new_secret",
        url: "https://new.example.test",
      })
      assert.deepStrictEqual(config.profiles.keep, {
        token: "kiln_cli_keep_secret",
        url: "https://keep.example.test",
      })
      assert.notInclude(await readFile(fixture.path, "utf8"), "old_secret")

      const recovered = memoryCredentialManager()
      const session = await Effect.runPromise(
        resolveSessionEffect({ profile: "keep" }, fixture.options([recovered]))
      )
      const migrated = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )

      assert.strictEqual(session.token, "kiln_cli_keep_secret")
      if (migrated.version !== 2) throw new Error("Expected version 2 config")
      assert.strictEqual(migrated.profiles.keep?.credential.kind, "external")
      assert.deepStrictEqual(migrated.profiles.replace?.credential, {
        kind: "legacy-file",
        token: "kiln_cli_new_secret",
      })
      assert.notInclude(
        await readFile(fixture.path, "utf8"),
        "kiln_cli_keep_secret"
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it("removes a legacy profile without migrating any credential", async () => {
    const fixture = await configFixture()
    try {
      await writeFile(
        fixture.path,
        `${JSON.stringify({
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
        })}\n`,
        { mode: 0o600 }
      )
      const manager = failingCredentialManager()

      const session = await Effect.runPromise(
        resolveSessionEffect(
          { migrateStoredCredential: false },
          fixture.options([manager])
        )
      )
      const removed = await Effect.runPromise(
        removeSessionEffect("remove", fixture.options([manager]))
      )
      const config = await Effect.runPromise(
        loadConfigEffect(fixture.options([]))
      )

      assert.strictEqual(session.token, "kiln_cli_remove_secret")
      assert.isTrue(removed.removed)
      assert.strictEqual(manager.setCalls, 0)
      if (config.version !== 1) throw new Error("Expected version 1 config")
      assert.isUndefined(config.profiles.remove)
      assert.deepStrictEqual(config.profiles.keep, {
        token: "kiln_cli_keep_secret",
        url: "https://keep.example.test",
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it("removes both profile metadata and its external credential", async () => {
    const fixture = await configFixture()
    try {
      const manager = memoryCredentialManager()
      await Effect.runPromise(
        saveSessionEffect(
          {
            profile: "delete-me",
            token: "kiln_cli_delete_secret",
            url: "https://kiln.example.test",
          },
          fixture.options([manager])
        )
      )
      assert.strictEqual(manager.passwords.size, 1)

      const removed = await Effect.runPromise(
        removeSessionEffect("delete-me", fixture.options([manager]))
      )

      assert.isTrue(removed.removed)
      assert.isTrue(removed.credentialRemoved)
      assert.strictEqual(manager.passwords.size, 0)
      assert.notInclude(await readFile(fixture.path, "utf8"), "delete-me")
    } finally {
      await fixture.cleanup()
    }
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

function failingCredentialManager(): CredentialManager & { setCalls: number } {
  const manager: CredentialManager & { setCalls: number } = {
    id: "failing",
    label: "Failing manager",
    setCalls: 0,
    deletePassword: async () => false,
    getPassword: async () => null,
    setPassword: async () => {
      manager.setCalls += 1
      throw new Error("unavailable")
    },
  }
  return manager
}

async function configFixture() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-cli-config-test-"))
  const path = join(directory, "config.json")
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    options: (
      credentialManagers: ReadonlyArray<CredentialManager>,
      environment: NodeJS.ProcessEnv = {}
    ): ConfigOptions => ({
      credentialManagers,
      environment: { ...environment, KILN_CONFIG: path },
    }),
    path,
  }
}

it("login uses the selected profile and honors KILN_URL and an explicit URL", async () => {
  const fixture = await configFixture()
  try {
    const options = fixture.options([memoryCredentialManager()])
    await Effect.runPromise(
      saveSessionEffect(
        {
          profile: "fork",
          token: "kiln_cli_test",
          url: "https://fork.example.com",
        },
        options
      )
    )
    expect(
      await Effect.runPromise(resolveLoginTargetEffect({}, options))
    ).toEqual({ profile: "fork", url: "https://fork.example.com" })
    const environment = {
      ...options.environment,
      KILN_URL: "https://env.example.com",
    }
    expect(
      (
        await Effect.runPromise(
          resolveLoginTargetEffect({}, { ...options, environment })
        )
      ).url
    ).toBe("https://env.example.com")
    expect(
      (
        await Effect.runPromise(
          resolveLoginTargetEffect(
            { url: "https://explicit.example.com" },
            { ...options, environment }
          )
        )
      ).url
    ).toBe("https://explicit.example.com")
  } finally {
    await fixture.cleanup()
  }
})
