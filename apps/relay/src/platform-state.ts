/**
 * What a Relay in platform mode keeps about the Kiln installation it hosts:
 * its identity, the secrets it generated, and the settings its services were
 * created with. The file is the installation's record. It is written before
 * anything is created, so a Relay interrupted halfway through installing
 * picks up with the same secrets and volumes, and it outlives the Relay's
 * container in the Relay's data volume.
 *
 * The format is read by other Relay versions and by recovery kits; change it
 * only by adding a new `formatVersion`.
 */
import { randomBytes } from "node:crypto"
import { mkdir, readFile, utimes } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { Effect, Predicate, Result, Schema } from "effect"

import { writeFileAtomic } from "./effect/atomic-file.js"

export const PLATFORM_STATE_FORMAT_VERSION = 1

const PlatformNamesSchema = Schema.Struct({
  cache: Schema.String,
  database: Schema.String,
  databaseVolume: Schema.String,
  hearth: Schema.String,
  network: Schema.String,
})

export const PlatformStateSchema = Schema.Struct({
  formatVersion: Schema.Literal(PLATFORM_STATE_FORMAT_VERSION),
  installationId: Schema.String,
  createdAt: Schema.String,
  /**
   * `installing` until Hearth first reports healthy, then `ready`.
   * `maintenance` holds Hearth stopped, for an offline restore, while its
   * database and cache keep running.
   */
  phase: Schema.Literals(["installing", "ready", "maintenance"]),
  /**
   * When the database first became healthy. From then on a missing database
   * volume means data was lost, and the Relay won't create an empty one in
   * its place unless an operator asks it to.
   */
  databaseInitializedAt: Schema.NullOr(Schema.String),
  /**
   * Pairing invitations the Relay made for the Hearth it installed. A Hearth
   * client paired through one of these may restart and repair Kiln's
   * services; other Hearths paired with this Relay may not.
   */
  ownerInvitationIds: Schema.Array(Schema.String),
  names: PlatformNamesSchema,
  secrets: Schema.Struct({
    /** Better Auth's versioned secret list, `1:<secret>`. */
    authSecrets: Schema.String,
    bootstrapToken: Schema.String,
    databasePassword: Schema.String,
    databaseRootPassword: Schema.String,
    platformBackupKey: Schema.String,
    /** Lets the first visitor who has it create the administrator. */
    setupToken: Schema.String,
  }),
  hearth: Schema.Struct({
    bindAddress: Schema.String,
    /** Passed through from the Relay's environment; see `platform.ts`. */
    environment: Schema.Record(Schema.String, Schema.String),
    image: Schema.String,
    port: Schema.Number,
    url: Schema.String,
  }),
  database: Schema.Struct({
    image: Schema.String,
    name: Schema.String,
    user: Schema.String,
  }),
  cache: Schema.NullOr(Schema.Struct({ image: Schema.String })),
  /**
   * Where Hearth reaches the Relay: its name on Kiln's network, which its
   * certificate is issued for, and its port. Saved by the running Relay, so
   * a command run from a recovery container gives Hearth the same.
   */
  relay: Schema.Struct({ host: Schema.String, port: Schema.Number }),
})

export type PlatformState = typeof PlatformStateSchema.Type
export type PlatformNames = PlatformState["names"]

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlatformStateSchema)
)

/**
 * The installation record as `kiln-relay platform export-kit` prints it, to
 * keep offline. With a platform backup it restores Kiln on a new host.
 */
export const PlatformRecoveryKitSchema = Schema.Struct({
  exportedAt: Schema.String,
  formatVersion: Schema.Literal(1),
  kind: Schema.Literal("kiln-platform-recovery-kit"),
  state: PlatformStateSchema,
})

export const decodePlatformRecoveryKit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlatformRecoveryKitSchema)
)

export class PlatformError extends Schema.TaggedError<PlatformError>()(
  "PlatformError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export function platformDirectory(dataDirectory: string): string {
  return join(dataDirectory, "platform")
}

function statePath(dataDirectory: string): string {
  return join(platformDirectory(dataDirectory), "installation.json")
}

function lockPath(dataDirectory: string): string {
  return join(platformDirectory(dataDirectory), "lock.sqlite")
}

/** The saved installation, or null when this Relay hasn't installed Kiln. */
export const readPlatformState = Effect.fn("Relay.platform.state.read")(
  function* (dataDirectory: string) {
    const text = yield* Effect.tryPromise({
      try: () => readFile(statePath(dataDirectory), "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        errorCode(cause) === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(
              PlatformError.make({
                reason: "Kiln's installation record can't be read",
                cause,
              })
            )
      )
    )
    if (text === null) return null
    return yield* decodeState(text).pipe(
      Effect.mapError((cause) =>
        PlatformError.make({
          reason:
            "Kiln's installation record is damaged or from a newer Relay; restore it from a recovery kit",
          cause,
        })
      )
    )
  }
)

export const writePlatformState = Effect.fn("Relay.platform.state.write")(
  function* (dataDirectory: string, state: PlatformState) {
    yield* Effect.tryPromise({
      try: () =>
        mkdir(platformDirectory(dataDirectory), {
          recursive: true,
          mode: 0o700,
        }),
      catch: (cause) =>
        PlatformError.make({
          reason: "Kiln's installation folder can't be created",
          cause,
        }),
    })
    yield* writeFileAtomic(
      statePath(dataDirectory),
      `${JSON.stringify(state, null, 2)}\n`,
      0o600
    ).pipe(
      Effect.mapError((cause) =>
        PlatformError.make({
          reason: "Kiln's installation record can't be saved",
          cause,
        })
      )
    )
  }
)

/** Reads, changes, and saves the record, holding the installation lock. */
export function updatePlatformState(
  dataDirectory: string,
  change: (state: PlatformState) => PlatformState
) {
  return withPlatformLock(
    dataDirectory,
    Effect.gen(function* () {
      const current = yield* readPlatformState(dataDirectory)
      if (!current) {
        return yield* PlatformError.make({
          reason: "This Relay hasn't installed Kiln",
        })
      }
      const next = change(current)
      if (next !== current) yield* writePlatformState(dataDirectory, next)
      return next
    })
  )
}

const LOCK_RETRY_MS = 250

/**
 * Runs `effect` holding the installation's lock. The running Relay and
 * `kiln-relay platform` commands, in the same container or a recovery
 * container sharing the volume, take it for every change to Kiln's
 * services, so one never undoes what another is doing.
 *
 * The lock is an exclusive SQLite transaction on a file in the data volume.
 * The kernel holds it for as long as the holder's process lives and drops
 * it when the process dies, so there is nothing to time out or reclaim.
 */
export function withPlatformLock<A, E, R>(
  dataDirectory: string,
  effect: Effect.Effect<A, E, R>,
  options: { readonly waitMs?: number } = {}
): Effect.Effect<A, E | PlatformError, R> {
  const acquire = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        mkdir(platformDirectory(dataDirectory), {
          recursive: true,
          mode: 0o700,
        }),
      catch: (cause) =>
        PlatformError.make({
          reason: "Kiln's installation folder can't be created",
          cause,
        }),
    })
    const database = yield* Effect.try({
      try: () => new DatabaseSync(lockPath(dataDirectory), { timeout: 0 }),
      catch: (cause) =>
        PlatformError.make({
          reason: "Kiln's installation lock can't be opened",
          cause,
        }),
    })
    const deadline = Date.now() + (options.waitMs ?? 10 * 60_000)
    while (true) {
      const taken = Result.try(() => database.exec("BEGIN EXCLUSIVE"))
      if (Result.isSuccess(taken)) return database
      if (!isBusy(taken.failure)) {
        database.close()
        return yield* PlatformError.make({
          reason: "Kiln's installation lock can't be taken",
          cause: taken.failure,
        })
      }
      if (Date.now() >= deadline) {
        database.close()
        return yield* PlatformError.make({
          reason:
            "Another Relay process is changing Kiln's services; try again once it finishes",
        })
      }
      yield* Effect.sleep(LOCK_RETRY_MS)
    }
  })
  return Effect.acquireUseRelease(
    acquire,
    () => effect,
    (database) =>
      Effect.sync(() => {
        Result.try(() => database.exec("ROLLBACK"))
        database.close()
      })
  )
}

function isBusy(cause: unknown): boolean {
  return (
    Predicate.hasProperty(cause, "errcode") &&
    (cause.errcode === 5 || cause.errcode === 6)
  )
}

/**
 * Keeps a lock file's modification time fresh while its holder runs, so
 * Kiln's updater doesn't take it for one a dead process left.
 */
export function renewLease(path: string, content: string): Effect.Effect<void> {
  return Effect.sleep(10_000).pipe(
    Effect.andThen(
      readOptional(() => readFile(path, "utf8")).pipe(
        Effect.flatMap((current) =>
          current === content
            ? Effect.tryPromise(() => {
                const now = new Date()
                return utimes(path, now, now)
              }).pipe(Effect.ignore)
            : Effect.void
        )
      )
    ),
    Effect.forever
  )
}

export function readOptional<A>(
  read: () => Promise<A>
): Effect.Effect<A | null> {
  return Effect.tryPromise(read).pipe(
    Effect.map((value): A | null => value),
    Effect.catch(() => Effect.succeed(null))
  )
}

/** A secret for one of Kiln's services: 48 random bytes, URL-safe. */
export function platformSecret(): string {
  return randomBytes(48).toString("base64url")
}

function errorCode(cause: unknown): string | null {
  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
    ? cause.code
    : null
}
