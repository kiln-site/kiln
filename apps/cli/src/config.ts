import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { Effect } from "effect"
import { z } from "zod"

import {
  credentialManagersForPlatform,
  type CredentialManager,
} from "./credential-store.js"
import { commandError } from "./errors.js"

export { cliDefaultUrl as DEFAULT_KILN_URL } from "./distribution.js"
import { cliDefaultUrl as DEFAULT_KILN_URL } from "./distribution.js"

const tokenSchema = z.string().startsWith("kiln_cli_")

const externalCredentialSchema = z.object({
  account: z.string().min(1),
  kind: z.literal("external"),
  manager: z.string().min(1),
})

const fileCredentialSchema = z.object({
  kind: z.literal("file"),
  token: tokenSchema,
})

const legacyFileCredentialSchema = z.object({
  kind: z.literal("legacy-file"),
  token: tokenSchema,
})

const profileSchema = z.object({
  credential: z.union([
    externalCredentialSchema,
    fileCredentialSchema,
    legacyFileCredentialSchema,
  ]),
  url: z.url(),
})

const configSchema = z.object({
  activeProfile: z.string().min(1).default("default"),
  profiles: z.record(z.string(), profileSchema).default({}),
  version: z.literal(2),
})

const legacyProfileSchema = z.object({
  token: tokenSchema,
  url: z.url(),
})

const legacyConfigSchema = z.object({
  activeProfile: z.string().min(1).default("default"),
  profiles: z.record(z.string(), legacyProfileSchema).default({}),
  version: z.literal(1),
})

type KilnConfig = z.infer<typeof configSchema>
type KilnCredential = z.infer<typeof profileSchema>["credential"]
type LegacyKilnConfig = z.infer<typeof legacyConfigSchema>
type StoredKilnConfig = KilnConfig | LegacyKilnConfig
type CredentialFallbackPolicy = "allow-on-failure" | "unavailable-only"

export interface KilnSession {
  profile: string
  token: string
  url: string
}

export interface ConfigOptions {
  credentialManagers?: ReadonlyArray<CredentialManager>
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
}

export type SavedSession =
  | {
      credentialManager: string
      credentialManagerLabel: string
      protected: true
    }
  | {
      credentialManager: "file"
      credentialManagerLabel: string
      fallbackReason: "manager-failed" | "manager-unavailable"
      protected: false
    }

const emptyConfig: KilnConfig = {
  activeProfile: "default",
  profiles: {},
  version: 2,
}

export const loadConfigEffect = Effect.fn("cli.config.load")(function* (
  options: ConfigOptions = {}
) {
  const path = configPath(options)
  const encoded = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if (isFileNotFound(cause)) return Effect.succeed(null)
      return Effect.fail(
        commandError({
          cause,
          code: "config_read_failed",
          message: `Could not read Kiln config at ${path}.`,
        })
      )
    })
  )
  if (encoded === null) return emptyConfig
  const parsed = yield* Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (cause) =>
      commandError({
        cause,
        code: "invalid_config",
        exitCode: 2,
        message: `Kiln config at ${path} is invalid.`,
      }),
  })
  const current = configSchema.safeParse(parsed)
  if (current.success) return current.data
  const legacy = legacyConfigSchema.safeParse(parsed)
  if (!legacy.success) {
    return yield* commandError({
      cause: current.error,
      code: "invalid_config",
      exitCode: 2,
      message: `Kiln config at ${path} is invalid.`,
    })
  }
  return legacy.data
})

export const resolveLoginTargetEffect = Effect.fn(
  "cli.config.resolveLoginTarget"
)(function* (
  input: { profile?: string; url?: string },
  options: ConfigOptions = {}
) {
  const config = yield* loadConfigEffect(options)
  const profile = input.profile || config.activeProfile || "default"
  const url =
    input.url ||
    (options.environment ?? process.env).KILN_URL?.trim() ||
    config.profiles[profile]?.url ||
    DEFAULT_KILN_URL
  if (!url)
    return yield* commandError({
      code: "invalid_url",
      exitCode: 2,
      message: "Provide your panel URL: kiln login https://hearth.example.com",
    })
  return { profile, url: normalizeKilnUrl(url) }
})

export const resolveSessionEffect = Effect.fn("cli.config.resolveSession")(
  function* (
    input: {
      migrateStoredCredential?: boolean
      profile?: string
      token?: string
      url?: string
    },
    options: ConfigOptions = {}
  ) {
    const config = yield* loadConfigEffect(options)
    const profile = input.profile || config.activeProfile || "default"
    const stored = config.profiles[profile]
    const environment = options.environment ?? process.env
    const url = normalizeKilnUrl(
      input.url ||
        environment.KILN_URL?.trim() ||
        stored?.url ||
        DEFAULT_KILN_URL
    )
    const explicitToken = input.token || environment.KILN_TOKEN?.trim()
    if (explicitToken) {
      return { profile, token: explicitToken, url } satisfies KilnSession
    }
    let token: string | null = null
    if (config.version === 1) {
      const legacyStored = config.profiles[profile]
      if (legacyStored) {
        token = legacyStored.token
        if (input.migrateStoredCredential !== false) {
          yield* migrateCredentialForUseEffect(config, profile, options).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      }
    } else {
      const currentStored = config.profiles[profile]
      if (currentStored?.credential.kind === "legacy-file") {
        token = currentStored.credential.token
        if (input.migrateStoredCredential !== false) {
          yield* migrateCredentialForUseEffect(config, profile, options).pipe(
            Effect.catch(() => Effect.void)
          )
        }
      } else if (currentStored) {
        token = yield* loadCredentialEffect(currentStored.credential, options)
      }
    }
    if (!token) {
      return yield* commandError({
        code: "authentication_required",
        exitCode: 3,
        message: "Run `kiln login` or provide KILN_TOKEN.",
      })
    }
    return { profile, token, url } satisfies KilnSession
  }
)

export const saveSessionEffect = Effect.fn("cli.config.saveSession")(function* (
  session: KilnSession,
  options: ConfigOptions = {}
) {
  const storedConfig = yield* loadConfigEffect(options)
  const config = toCurrentConfig(storedConfig)
  const existing = config.profiles[session.profile]?.credential
  const account =
    existing && existing.kind === "external"
      ? existing.account
      : credentialAccount(configPath(options), session.profile)
  const saved = yield* saveCredentialEffect(
    account,
    session.token,
    options,
    "allow-on-failure"
  )
  if (storedConfig.version === 1 && saved.credential.kind === "file") {
    yield* writeConfigEffect(
      {
        activeProfile: session.profile,
        profiles: {
          ...storedConfig.profiles,
          [session.profile]: { token: session.token, url: session.url },
        },
        version: 1,
      },
      options
    )
  } else {
    yield* writeConfigEffect(
      {
        activeProfile: session.profile,
        profiles: {
          ...config.profiles,
          [session.profile]: { credential: saved.credential, url: session.url },
        },
        version: 2,
      },
      options
    )
  }
  if (
    existing &&
    existing.kind === "external" &&
    (saved.credential.kind === "file" ||
      existing.manager !== saved.credential.manager)
  ) {
    yield* deleteExternalCredentialEffect(existing, options).pipe(Effect.ignore)
  }
  return saved.summary
})

export const removeSessionEffect = Effect.fn("cli.config.removeSession")(
  function* (profileName?: string, options: ConfigOptions = {}) {
    const storedConfig = yield* loadConfigEffect(options)
    const profile = profileName || storedConfig.activeProfile || "default"
    const removed = storedConfig.profiles[profile]
    if (!removed) {
      return { credentialRemoved: true, profile, removed: false }
    }
    const profiles = Object.fromEntries(
      Object.entries(storedConfig.profiles).filter(([name]) => name !== profile)
    )
    yield* writeConfigEffect(
      {
        activeProfile:
          storedConfig.activeProfile === profile
            ? "default"
            : storedConfig.activeProfile,
        profiles,
        version: storedConfig.version,
      },
      options
    )
    const credentialRemoved =
      "credential" in removed && removed.credential.kind === "external"
        ? yield* deleteExternalCredentialEffect(
            removed.credential,
            options
          ).pipe(Effect.catch(() => Effect.succeed(false)))
        : true
    return {
      credentialRemoved,
      profile,
      removed: true,
    }
  }
)

export function normalizeKilnUrl(input: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(input)
    ? input
    : `https://${input}`
  const parsed = z.url().safeParse(candidate)
  if (!parsed.success) {
    throw commandError({
      code: "invalid_url",
      exitCode: 2,
      message: "Kiln URL must be an absolute HTTP or HTTPS URL.",
    })
  }
  const url = new URL(parsed.data)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw commandError({
      code: "invalid_url",
      exitCode: 2,
      message: "Kiln URL must use HTTP or HTTPS.",
    })
  }
  return url.toString().replace(/\/$/u, "")
}

function migrateCredentialForUseEffect(
  storedConfig: StoredKilnConfig,
  profile: string,
  options: ConfigOptions
) {
  return Effect.gen(function* () {
    const config = toCurrentConfig(storedConfig)
    const stored = config.profiles[profile]
    if (!stored || stored.credential.kind !== "legacy-file") return
    const saved = yield* saveCredentialEffect(
      credentialAccount(configPath(options), profile),
      stored.credential.token,
      options,
      "unavailable-only"
    )
    const migrated: KilnConfig = {
      ...config,
      profiles: {
        ...config.profiles,
        [profile]: { credential: saved.credential, url: stored.url },
      },
    }
    yield* writeConfigEffect(migrated, options)
  })
}

function toCurrentConfig(config: StoredKilnConfig): KilnConfig {
  if (config.version === 2) return config
  const profiles: KilnConfig["profiles"] = {}
  for (const [profile, value] of Object.entries(config.profiles)) {
    profiles[profile] = {
      credential: { kind: "legacy-file", token: value.token },
      url: value.url,
    }
  }
  return {
    activeProfile: config.activeProfile,
    profiles,
    version: 2,
  }
}

function loadCredentialEffect(
  credential: KilnCredential,
  options: ConfigOptions
) {
  if (credential.kind !== "external") return Effect.succeed(credential.token)
  const manager = credentialManagers(options).find(
    (candidate) => candidate.id === credential.manager
  )
  if (!manager) {
    return Effect.fail(
      commandError({
        code: "credential_manager_unavailable",
        exitCode: 3,
        message: `The saved credential requires ${credential.manager}, which is unavailable on this system.`,
      })
    )
  }
  return Effect.tryPromise({
    try: (signal) => manager.getPassword(credential.account, signal),
    catch: (cause) =>
      commandError({
        cause,
        code: "credential_read_failed",
        exitCode: 3,
        message: `Could not read the Kiln credential from ${manager.label}.`,
      }),
  }).pipe(
    Effect.flatMap((token) =>
      token
        ? Effect.succeed(token)
        : Effect.fail(
            commandError({
              code: "authentication_required",
              exitCode: 3,
              message: `The Kiln credential is missing from ${manager.label}. Run \`kiln login\` again.`,
            })
          )
    )
  )
}

function saveCredentialEffect(
  account: string,
  token: string,
  options: ConfigOptions,
  fallbackPolicy: CredentialFallbackPolicy
) {
  return Effect.gen(function* () {
    const managers = credentialManagers(options)
    let lastFailure: unknown
    for (const manager of managers) {
      const stored = yield* Effect.tryPromise((signal) =>
        manager.setPassword(account, token, signal)
      ).pipe(
        Effect.as(true),
        Effect.catch((cause) => {
          lastFailure = cause
          return Effect.succeed(false)
        })
      )
      if (stored) {
        return {
          credential: {
            account,
            kind: "external",
            manager: manager.id,
          } satisfies KilnCredential,
          summary: {
            credentialManager: manager.id,
            credentialManagerLabel: manager.label,
            protected: true,
          } satisfies SavedSession,
        }
      }
    }
    if (managers.length > 0 && fallbackPolicy === "unavailable-only") {
      const labels = managers.map((manager) => manager.label).join(" or ")
      return yield* commandError({
        cause: lastFailure,
        code: "credential_store_failed",
        message: `Could not migrate the saved Kiln credential to ${labels}. The existing config was not changed; unlock the credential manager and retry.`,
        retryable: true,
      })
    }
    return {
      credential: { kind: "file", token } satisfies KilnCredential,
      summary: {
        credentialManager: "file",
        credentialManagerLabel:
          managers.length > 0
            ? managers.map((manager) => manager.label).join(" or ")
            : "the Kiln config file",
        fallbackReason:
          managers.length > 0 ? "manager-failed" : "manager-unavailable",
        protected: false,
      } satisfies SavedSession,
    }
  })
}

function deleteExternalCredentialEffect(
  credential: z.infer<typeof externalCredentialSchema>,
  options: ConfigOptions
) {
  const manager = credentialManagers(options).find(
    (candidate) => candidate.id === credential.manager
  )
  if (!manager) return Effect.succeed(false)
  return Effect.tryPromise((signal) =>
    manager.deletePassword(credential.account, signal)
  )
}

function credentialManagers(
  options: ConfigOptions
): ReadonlyArray<CredentialManager> {
  return options.credentialManagers ?? credentialManagersForPlatform()
}

function credentialAccount(path: string, profile: string): string {
  const digest = createHash("sha256")
    .update(resolve(path))
    .update("\0")
    .update(profile)
    .digest("hex")
  return `profile-${digest}`
}

function configPath(options: ConfigOptions): string {
  const environment = options.environment ?? process.env
  const configured = environment.KILN_CONFIG?.trim()
  if (configured) return configured
  const base =
    environment.XDG_CONFIG_HOME?.trim() ||
    join(options.homeDirectory ?? homedir(), ".config")
  return join(base, "kiln", "config.json")
}

function writeConfigEffect(config: StoredKilnConfig, options: ConfigOptions) {
  const path = configPath(options)
  const temporary = `${path}.tmp-${process.pid}`
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    },
    catch: (cause) =>
      commandError({
        cause,
        code: "config_write_failed",
        message: `Could not write Kiln config at ${path}.`,
      }),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => unlink(temporary),
        catch: () => undefined,
      }).pipe(Effect.ignore)
    )
  )
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  )
}
