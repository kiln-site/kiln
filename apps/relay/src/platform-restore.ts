/**
 * Restoring Kiln on a new machine from a platform backup and its recovery
 * code, in two steps:
 *
 * 1. `kiln-relay platform restore <backup>`, on a new Relay before its first
 *    start, authenticates the backup with the code and takes back what it
 *    carries: the lost Relay's identity, TLS authority, and the Hearths it
 *    trusted, so the restored Hearth finds the Relay it knew, and Kiln's
 *    installation record, with Hearth held stopped. Kiln gets a new
 *    installation ID, so it's known the machine changed, and keeps the ones
 *    before it, whose backups still restore here. It leaves the backup for
 *    the next step.
 * 2. The Relay's first start creates Kiln's empty database, restores the
 *    backup into it, and starts Hearth, which hears that it was restored.
 *
 * Neither step is resumed: the machine has nothing else on it, so a restore
 * that fails or stops before Kiln is ready starts over from a clean Relay
 * (the installer removes what it set up). Until then the backup's record on
 * the Relay (`restore.json`) says a restore is under way; it goes just before
 * Kiln is marked ready.
 *
 * A format 1 backup carries none of that; it restores with a recovery kit
 * (`import-kit`) instead.
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import { decodeRecoveryCode } from "@workspace/contracts"
import { Effect, Schema } from "effect"

import type { RelayConfig } from "./config.js"
import type { DockerEngine } from "./docker-engine.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { writeRelayIdentityMaterial } from "./effect/identity.js"
import type { RelayStateStore } from "./effect/state.js"
import { writeRelayCertificateAuthority } from "./effect/tls.js"
import {
  defaultHearthImage,
  newPlatformState,
  ownContainer,
  platformInputs,
} from "./platform.js"
import {
  readPlatformBackupRecovery,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
import {
  PlatformError,
  platformDirectory,
  readPlatformState,
  withPlatformLock,
  writePlatformState,
  type PlatformState,
} from "./platform-state.js"

const PendingRestoreSchema = Schema.Struct({
  /** Why restoring it failed; the restore then starts over. */
  error: Schema.NullOr(Schema.String),
  /**
   * Set as the import starts: a Relay that finds it set had stopped part
   * way through, over a database it can't trust, so it doesn't import again.
   */
  importing: Schema.optionalKey(Schema.Boolean),
  restoredAt: Schema.String,
})

const RestoredSchema = Schema.Struct({ restoredAt: Schema.String })

const pendingPath = (dataDirectory: string) =>
  join(platformDirectory(dataDirectory), "restore.json")
const restoredPath = (dataDirectory: string) =>
  join(platformDirectory(dataDirectory), "restored.json")
/** The backup waiting to be restored, in the Relay's own data. */
const pendingBackupPath = (dataDirectory: string) =>
  resolve(dataDirectory, "restores", "platform-restore.kiln")

/**
 * Step 1: makes this new Relay the one a platform backup came from, with
 * Kiln installed and held stopped until its first start restores the
 * backup. `url` replaces the address Hearth had.
 */
export const restorePlatformFromBackup = Effect.fn("Relay.platform.restore")(
  function* (input: {
    readonly code: string
    readonly config: RelayConfig
    readonly engine: DockerEngine
    readonly source: string
    readonly state: RelayStateStore["Service"]
    readonly url: string | null
  }) {
    const { config } = input
    const platformBackupKey = decodeRecoveryCode(input.code)
    if (!platformBackupKey) {
      return yield* new PlatformError({
        reason:
          "That isn't a Kiln recovery code. It starts with kiln-rk-; copy it again in full.",
      })
    }
    if (yield* readPlatformState(config.dataDirectory)) {
      return yield* new PlatformError({
        reason:
          "This Relay already has an installation; restore onto a new Relay",
      })
    }
    if (yield* restoreWaiting(config.dataDirectory)) {
      return yield* new PlatformError({
        reason:
          "A restore on this Relay didn't finish. Start over on a new Relay: remove this one's volume first.",
      })
    }
    if ((yield* input.state.listClients()).length > 0) {
      return yield* new PlatformError({
        reason: "This Relay is already paired; restore onto a new Relay",
      })
    }
    const { manifest, recovery } = yield* Effect.tryPromise({
      try: () => readPlatformBackupRecovery(platformBackupKey, input.source),
      catch: (cause) =>
        new PlatformError({
          reason:
            "That backup doesn't open with this recovery code, or it's damaged",
          cause,
        }),
    })
    if (!recovery) {
      return yield* new PlatformError({
        reason:
          "That backup is from before Kiln's backups carried what restores them (format 1). Restore it with its recovery kit: `kiln-relay platform import-kit`, then `kiln-relay platform-backup restore`.",
      })
    }
    const url = input.url ?? recovery.hearthUrl
    const relayImage = yield* ownContainer(input.engine, config).pipe(
      Effect.map((own) => own?.Config.Image ?? null),
      Effect.catch(() => Effect.succeed(null))
    )
    const restored = newPlatformState(
      { ...config, platformBackupKey },
      {
        ...platformInputs(),
        authSecrets: recovery.authSecrets,
        // A new one, whatever the environment says.
        installationId: null,
        url,
      },
      defaultHearthImage(relayImage, config.gitRepository)
    )
    const installation: PlatformState = {
      ...restored,
      // The Hearths this Relay trusts again, as it did before.
      ownerInvitationIds: recovery.ownerInvitationIds,
      previousInstallationIds: [
        ...new Set([
          ...recovery.previousInstallationIds,
          manifest.installationId,
        ]),
      ].filter((id) => id !== restored.installationId),
      // Held stopped until the first start restores the backup.
      phase: "maintenance",
    }

    const backup = pendingBackupPath(config.dataDirectory)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(resolve(backup, ".."), { mode: 0o700, recursive: true })
        await mkdir(platformDirectory(config.dataDirectory), {
          mode: 0o700,
          recursive: true,
        })
        if (resolve(input.source) !== backup) {
          await copyFile(input.source, backup)
        }
      },
      catch: (cause) =>
        new PlatformError({
          reason: "Can't keep the backup to restore",
          cause,
        }),
    })
    yield* writeJson(pendingPath(config.dataDirectory), {
      error: null,
      restoredAt: new Date().toISOString(),
    } satisfies typeof PendingRestoreSchema.Type)
    yield* writeRelayIdentityMaterial(config, recovery.relay.identity)
    if (recovery.relay.tlsAuthority) {
      yield* writeRelayCertificateAuthority(config, recovery.relay.tlsAuthority)
    }
    yield* input.state.restoreClients(recovery.relay.clients)
    yield* withPlatformLock(
      config.dataDirectory,
      writePlatformState(config.dataDirectory, installation)
    )
    return {
      installationId: installation.installationId,
      previousInstallationId: manifest.installationId,
      url,
    }
  }
)

/**
 * Step 2, from a pass over Kiln's services once its database is up: restores
 * the waiting backup and lets Hearth start. Null when nothing waits; an
 * issue when restoring failed, which isn't tried again.
 */
export const completePendingRestore = Effect.fn(
  "Relay.platform.restore.complete"
)(function* (config: RelayConfig, state: PlatformState) {
  const pending = yield* readJson(
    pendingPath(config.dataDirectory),
    PendingRestoreSchema
  )
  if (!pending) return null
  if (pending.error) {
    return { outcome: "failed", issue: restoreFailed(pending.error) } as const
  }
  // Stopped after the import succeeded: it's in, so it isn't imported again.
  if (yield* restoredDone(config.dataDirectory, pending)) {
    return yield* finishRestore(config, state)
  }
  if (pending.importing) {
    const error = "the Relay stopped while it was restoring the backup"
    yield* writeJson(pendingPath(config.dataDirectory), { ...pending, error })
    return { outcome: "failed", issue: restoreFailed(error) } as const
  }
  yield* writeJson(pendingPath(config.dataDirectory), {
    ...pending,
    importing: true,
  })
  const restored = yield* Effect.tryPromise({
    try: () =>
      restoreEncryptedPlatformBackup(
        config,
        pendingBackupPath(config.dataDirectory),
        state.installationId
      ),
    catch: (cause) => cause,
  }).pipe(Effect.result)
  if (restored._tag === "Failure") {
    const error =
      restored.failure instanceof Error
        ? restored.failure.message
        : String(restored.failure)
    yield* writeJson(pendingPath(config.dataDirectory), {
      ...pending,
      error,
    })
    return { outcome: "failed", issue: restoreFailed(error) } as const
  }
  // The record that the backup is in: from here the restore is never
  // started over, and a Relay that stops before Kiln is ready finishes it.
  yield* writeJson(restoredPath(config.dataDirectory), {
    restoredAt: pending.restoredAt,
  } satisfies typeof RestoredSchema.Type)
  return yield* finishRestore(config, state)
})

// Kiln ready first, then what the restore left: a Relay that stops in
// between has a committed restore (`restoredDone`) to clear on its next pass.
const finishRestore = Effect.fnUntraced(function* (
  config: RelayConfig,
  state: PlatformState
) {
  const next: PlatformState = { ...state, phase: "ready" }
  yield* writePlatformState(config.dataDirectory, next)
  yield* removeRestoreFiles(config.dataDirectory)
  return { outcome: "restored", state: next } as const
})

const removeRestoreFiles = (dataDirectory: string) =>
  Effect.tryPromise({
    try: async () => {
      await rm(pendingBackupPath(dataDirectory), { force: true })
      await rm(pendingPath(dataDirectory), { force: true })
    },
    catch: (cause) =>
      new PlatformError({ reason: "Can't remove the restored backup", cause }),
  })

// Whether a restore's record is of one whose backup is in, so it's only
// left over from a Relay that stopped before it removed it.
const restoredDone = Effect.fnUntraced(function* (
  dataDirectory: string,
  pending: typeof PendingRestoreSchema.Type
) {
  const finished = yield* readJson(restoredPath(dataDirectory), RestoredSchema)
  return finished?.restoredAt === pending.restoredAt
})

/** Removes what a restore whose backup is in left behind, if anything. */
export const clearFinishedRestore = Effect.fn("Relay.platform.restore.clear")(
  function* (dataDirectory: string) {
    const pending = yield* readJson(
      pendingPath(dataDirectory),
      PendingRestoreSchema
    )
    if (pending && (yield* restoredDone(dataDirectory, pending))) {
      yield* removeRestoreFiles(dataDirectory)
    }
  }
)

// On one line, for the installer, however many lines the error had.
const restoreFailed = (error: string) =>
  `Restoring Kiln's backup failed: ${error.replace(/\s+/gu, " ").trim()}. Start the restore over: run the installer with --restore again, or remove the Relay's volume and run \`kiln-relay platform restore\` again.`

/**
 * The restore under way on this Relay, with why it failed if it did, or
 * null when there's none: Kiln isn't ready until it's done.
 */
export const restoreWaiting = Effect.fn("Relay.platform.restore.waiting")(
  function* (dataDirectory: string) {
    const pending = yield* readJson(
      pendingPath(dataDirectory),
      PendingRestoreSchema
    )
    if (!pending || (yield* restoredDone(dataDirectory, pending))) return null
    return { problem: pending.error ? restoreFailed(pending.error) : null }
  }
)

/**
 * When Kiln was last restored from a backup on this Relay, for Hearth to
 * hear on its first start after it; null when it never was.
 */
export const readRestoredAt = Effect.fn("Relay.platform.restore.read")(
  function* (dataDirectory: string) {
    const restored = yield* readJson(
      restoredPath(dataDirectory),
      RestoredSchema
    )
    return restored?.restoredAt ?? null
  }
)

const readJson = <S extends Schema.Top>(path: string, schema: S) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(
      (cause) => (cause as NodeJS.ErrnoException)?.code === "ENOENT",
      () => Effect.succeed(null)
    ),
    Effect.flatMap((text) =>
      text === null
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)
    ),
    Effect.mapError(
      (cause) => new PlatformError({ reason: `Can't read ${path}`, cause })
    )
  )

const writeJson = (path: string, value: unknown) =>
  writeFileAtomic(path, `${JSON.stringify(value)}\n`, 0o600).pipe(
    Effect.mapError(
      (cause) => new PlatformError({ reason: `Can't write ${path}`, cause })
    )
  )
