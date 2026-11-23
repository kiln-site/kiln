/**
 * `kiln-relay platform restore`: puts a platform backup back.
 *
 * On a new machine it first takes back what the backup carries, the
 * installation's record and the Relay's identity, so it's the same Kiln on
 * the same Relay. On a machine that has that Kiln, it first saves what's in
 * the database, so the restore can be undone with another. Either way it then
 * holds Hearth stopped, replaces the database with the backup's, and lets
 * Hearth run.
 *
 * Nothing records how far it got. Every step can be repeated, so one that
 * fails or is stopped is run again from the start, and Hearth stays stopped
 * until one finishes.
 */
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { decodeRecoveryCode } from "@workspace/contracts"
import { Effect, Predicate } from "effect"

import type { RelayConfig } from "./config.js"
import type { DockerEngine } from "./docker-engine.js"
import {
  readRelayIdentityMaterial,
  writeRelayIdentityMaterial,
} from "./effect/identity.js"
import type { RelayStateStore } from "./effect/state.js"
import { writeRelayCertificateAuthority } from "./effect/tls.js"
import { savedInstallationId } from "./installation.js"
import {
  DEFAULT_BIND_ADDRESS,
  defaultHearthImage,
  ownContainer,
  platformInputs,
  platformNames,
  reconcilePlatform,
  withPlatformRestoreHold,
} from "./platform.js"
import {
  clearPlatformStaging,
  createEncryptedPlatformBackup,
  readPlatformBackupRecovery,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
import {
  collectPlatformRecovery,
  type PlatformRecovery,
} from "./platform-recovery.js"
import {
  PlatformError,
  platformDirectory,
  readPlatformState,
  updatePlatformState,
  withPlatformLock,
  writePlatformState,
  type PlatformState,
} from "./platform-state.js"

export interface PlatformRestoreInput {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  readonly environment?: NodeJS.ProcessEnv
  readonly print: (text: string) => void
  /** Asked for only when this machine doesn't have the Kiln already. */
  readonly recoveryCode: () => Promise<string>
  readonly source: string
  readonly state: RelayStateStore["Service"]
}

export const restorePlatform = Effect.fn("Relay.platform.restore")(function* (
  input: PlatformRestoreInput
) {
  const { config, engine, print, source } = input
  const existing = yield* readPlatformState(config.dataDirectory)
  const key = existing
    ? existing.secrets.platformBackupKey
    : yield* keyFromCode(input.recoveryCode)
  const { manifest, recovery } = yield* Effect.tryPromise({
    try: () => readPlatformBackupRecovery(key, source),
    catch: (cause) =>
      new PlatformError({
        reason:
          Predicate.hasProperty(cause, "code") && cause.code === "ENOENT"
            ? `There's no backup at ${source}`
            : `That backup doesn't open with ${existing ? "this Kiln's key" : "this recovery code"}, or it's damaged`,
        cause,
      }),
  })
  if (existing && existing.installationId !== manifest.installationId) {
    return yield* new PlatformError({
      reason: `That backup is of another Kiln (${manifest.installationId}), and this machine has ${existing.installationId}. Restore it on a machine without Kiln.`,
    })
  }
  print(`Opened the backup of Kiln ${manifest.installationId}`)
  const installed = existing ?? (yield* putBack(input, recovery))

  // Its own key and ID, which the running Relay takes from the same record.
  const restoreConfig: RelayConfig = {
    ...config,
    installationId: installed.installationId,
    installationIdConfigured: true,
    platformBackupKey: key,
  }
  yield* updatePlatformState(config.dataDirectory, (current) => ({
    ...current,
    // The database may have been lost: a missing one starts empty.
    databaseInitializedAt: null,
    phase: "maintenance",
  }))
  const held = yield* reconcilePlatform({ config: restoreConfig, engine })
  if (held.issue) {
    return yield* new PlatformError({
      reason: `${held.issue}. Hearth is stopped until a restore finishes; run this again`,
    })
  }

  const saved = yield* withPlatformRestoreHold(
    config,
    Effect.gen(function* () {
      // Before saving anything, which may need the room.
      yield* Effect.tryPromise(() => clearPlatformStaging(config))
      const undo = existing
        ? yield* saveDatabase(restoreConfig, input.state, existing)
        : null
      if (undo) print(`Saved what was here to ${undo}`)
      print("Restoring Kiln's database")
      yield* Effect.tryPromise({
        try: () =>
          restoreEncryptedPlatformBackup(
            restoreConfig,
            source,
            installed.installationId
          ),
        catch: (cause) =>
          new PlatformError({
            reason: `Couldn't restore Kiln's database: ${cause instanceof Error ? cause.message : String(cause)}. Hearth is stopped until a restore finishes; run this again`,
            cause,
          }),
      })
      return undo
    })
  )
  // Hearth sends those in the database that's there now.
  yield* input.state.schedules.forget()
  const restored = yield* updatePlatformState(
    config.dataDirectory,
    (current) => ({
      ...current,
      phase: "ready",
      restored: {
        at: new Date().toISOString(),
        backupCreatedAt: manifest.createdAt,
      },
    })
  )
  print(`Restored Kiln from its backup of ${manifest.createdAt}`)
  // One that started with Hearth held stopped may follow a run that replaced
  // part of the database, so what it saved may not be what to go back to.
  if (saved && existing?.phase === "ready") {
    print(`To undo: kiln-relay platform restore ${saved}`)
  }
  return restored
})

const keyFromCode = Effect.fnUntraced(function* (
  recoveryCode: () => Promise<string>
) {
  const key = decodeRecoveryCode(
    yield* Effect.tryPromise({
      try: recoveryCode,
      catch: (cause) =>
        new PlatformError({ reason: "Couldn't read the recovery code", cause }),
    })
  )
  if (key) return key
  return yield* new PlatformError({
    reason:
      "That isn't a Kiln recovery code. It starts with kiln-rk-; copy it again in full.",
  })
})

/**
 * Makes this new Relay the one the backup came from. The record is written
 * last, so a Relay that has it has the rest.
 */
const putBack = Effect.fnUntraced(function* (
  { config, engine, environment, state }: PlatformRestoreInput,
  recovery: PlatformRecovery | null
) {
  if (!recovery) {
    return yield* new PlatformError({
      reason:
        "That backup is from before Kiln's backups carried what restores them (format 1). Restore it with its recovery kit: `kiln-relay platform import-kit`, then `kiln-relay platform-backup restore`.",
    })
  }
  const identity = yield* readRelayIdentityMaterial(config).pipe(
    Effect.catch(() => Effect.succeed(null))
  )
  // A new Relay has an identity before anything knows it by it; one that
  // ever served a Hearth is in use. One stopped partway has the backup's.
  if (
    identity?.id !== recovery.relay.identity.id &&
    ((yield* state.listClients()).length > 0 ||
      (yield* savedInstallationId(state)) !== null)
  ) {
    return yield* new PlatformError({
      reason:
        "This machine already has another Relay. Restore Kiln on a machine without one, or use another KILN_RELAY_RESOURCE_NAMESPACE and volume.",
    })
  }
  const inputs = platformInputs(environment)
  const { installation } = recovery
  // That address isn't this machine's, and every address would open up a
  // Hearth that wasn't.
  if (
    !inputs.bindAddress &&
    installation.hearth.bindAddress !== DEFAULT_BIND_ADDRESS
  ) {
    return yield* new PlatformError({
      reason: `That Kiln listened only on ${installation.hearth.bindAddress}. Say where it listens on this machine, with --bind when installing or with KILN_PLATFORM_HEARTH_BIND; ${DEFAULT_BIND_ADDRESS} is every address.`,
    })
  }
  const relayImage = yield* ownContainer(engine, config).pipe(
    Effect.map((own) => own?.Config.Image ?? null),
    Effect.catch(() => Effect.succeed(null))
  )
  // This release's Hearth, at the address it had unless given another.
  const restored: PlatformState = {
    ...installation,
    databaseInitializedAt: null,
    hearth: {
      ...installation.hearth,
      bindAddress: inputs.bindAddress ?? DEFAULT_BIND_ADDRESS,
      image:
        inputs.hearthImage ??
        defaultHearthImage(relayImage, config.gitRepository),
      url: inputs.url ? new URL(inputs.url).origin : installation.hearth.url,
    },
    names: platformNames(config),
    phase: "maintenance",
  }
  yield* writeRelayIdentityMaterial(config, recovery.relay.identity)
  if (recovery.relay.tlsAuthority) {
    yield* writeRelayCertificateAuthority(config, recovery.relay.tlsAuthority)
  }
  yield* state.restoreClients(recovery.relay.clients)
  yield* withPlatformLock(
    config.dataDirectory,
    writePlatformState(config.dataDirectory, restored)
  )
  return restored
})

/**
 * Saves the database as it is, as a platform backup beside the installation's
 * record; null when there's no database, as after one that stopped partway.
 */
const saveDatabase = Effect.fnUntraced(function* (
  config: RelayConfig,
  state: RelayStateStore["Service"],
  installation: PlatformState
) {
  const path = join(
    platformDirectory(config.dataDirectory),
    `before-restore-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.kiln`
  )
  const recovery = yield* collectPlatformRecovery(config, state)
  return yield* Effect.tryPromise({
    try: async () => {
      await rm(path, { force: true })
      await createEncryptedPlatformBackup(
        config,
        {
          backupId: randomUUID(),
          maxBytes: null,
          target: { id: installation.installationId, kind: "platform" },
        },
        path,
        { completed: 0, total: 0 },
        new AbortController().signal,
        recovery
      )
      return path
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      const reason = cause instanceof Error ? cause.message : String(cause)
      return reason.includes("Unknown database")
        ? Effect.succeed(null)
        : Effect.fail(
            new PlatformError({
              reason: `Couldn't save what's in Kiln's database first, so nothing was restored: ${reason}. Start Hearth again with \`kiln-relay platform start-hearth\`, or restore without saving it: \`kiln-relay platform-backup restore <backup> --confirm ${installation.installationId}\``,
              cause,
            })
          )
    })
  )
})
