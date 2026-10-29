import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"

import type { RelayConfig } from "../config.js"
import { writeFileAtomic } from "../effect/atomic-file.js"
import { laneKeys, type LaneLock } from "../operation-lanes.js"

/**
 * What a restore of an App's folder or a volume has done so far, kept on
 * disk so a Relay that stops midway, or a swap that fails, finishes or undoes
 * it. Once a restore begins clearing the old files, its target holds neither
 * the old copy nor the restored one, so the journal also fences the target:
 * the lanes refuse other work on it, and the start of every App that uses
 * it, until the restore finishes or is abandoned (`TarRestoreFences`).
 */

const TarSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("volume"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("bind"), path: Schema.String }),
])

const TarRestoreRootSchema = Schema.Struct({
  gid: Schema.Number,
  mode: Schema.Number,
  uid: Schema.Number,
  /** The root's extended attributes, as the archive's PAX records name them. */
  xattrs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const TarRestoreJournalSchema = Schema.Struct({
  /** Apps using the target when it began, whose starts wait for it. */
  consumers: Schema.Array(Schema.String),
  phase: Schema.Literals(["staging", "clearing", "installing"]),
  root: Schema.NullOr(TarRestoreRootSchema),
  source: TarSourceSchema,
  target: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["app", "volume"]),
  }),
  taskId: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    )
  ),
  version: Schema.Literal(1),
})

export type TarRestoreJournal = typeof TarRestoreJournalSchema.Type

/** Every restore journal a Relay kept, dropping files that aren't one. */
export async function readTarRestoreJournals(
  config: RelayConfig
): Promise<Array<TarRestoreJournal>> {
  const directory = journalDirectory(config)
  await mkdir(directory, { mode: 0o700, recursive: true })
  const journals: Array<TarRestoreJournal> = []
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".json")) continue
    const path = join(directory, name)
    // A recovery may have resolved this entry since the directory read.
    const text = await readIfPresent(path)
    if (text === null) continue
    const journal = decodeJournal(text)
    if (!journal || `${journal.taskId}.json` !== name) {
      await rm(path, { force: true })
      continue
    }
    journals.push(journal)
  }
  return journals
}

/** Reads the current journal after its recovery locks have been acquired. */
export async function readTarRestoreJournal(
  config: RelayConfig,
  taskId: string
): Promise<TarRestoreJournal | null> {
  const text = await readIfPresent(
    join(journalDirectory(config), `${taskId}.json`)
  )
  if (text === null) return null
  const journal = decodeJournal(text)
  if (!journal || journal.taskId !== taskId) {
    throw new Error("The restore journal is invalid")
  }
  return journal
}

// A journal that isn't there is resolved; anything else unreadable fails.
function readIfPresent(path: string): Promise<string | null> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchIf(
        (cause) =>
          cause instanceof Error && "code" in cause && cause.code === "ENOENT",
        () => Effect.succeed(null)
      )
    )
  )
}

export async function writeTarRestoreJournal(
  config: RelayConfig,
  journal: TarRestoreJournal
): Promise<void> {
  await mkdir(journalDirectory(config), { mode: 0o700, recursive: true })
  await Effect.runPromise(
    writeFileAtomic(
      join(journalDirectory(config), `${journal.taskId}.json`),
      `${JSON.stringify(journal)}\n`,
      0o600
    )
  )
}

export async function removeTarRestoreJournal(
  config: RelayConfig,
  taskId: string
): Promise<void> {
  await rm(join(journalDirectory(config), `${taskId}.json`), { force: true })
}

/** The label of the work that finishes or abandons an unfinished restore. */
export const TAR_RESTORE_RECOVERY_LABEL = "backup.restore.recover"

/**
 * The targets of restores that began swapping and haven't finished, as the
 * lanes see them. Loaded from the journals before any work is admitted, and
 * kept in step with them: fenced as a restore begins clearing, lifted once
 * it's finished or abandoned. Only the work that recovers a restore runs on
 * a fenced target.
 */
export class TarRestoreFences {
  readonly #fences = new Map<string, TarRestoreJournal>()

  static async load(config: RelayConfig): Promise<TarRestoreFences> {
    const fences = new TarRestoreFences()
    for (const journal of await readTarRestoreJournals(config)) {
      if (journal.phase !== "staging") fences.fence(journal)
    }
    return fences
  }

  fence(journal: TarRestoreJournal): void {
    this.#fences.set(targetKey(journal.target), journal)
  }

  lift(taskId: string): void {
    for (const [key, journal] of this.#fences) {
      if (journal.taskId === taskId) this.#fences.delete(key)
    }
  }

  /** Every unfinished restore fencing a target. */
  list(): Array<TarRestoreJournal> {
    return [...this.#fences.values()]
  }

  /** The unfinished restore fencing a target, if one is. */
  find(kind: "app" | "volume", id: string): TarRestoreJournal | null {
    return this.#fences.get(targetKey({ id, kind })) ?? null
  }

  /**
   * Why an operation may not run: it touches a fenced target, or starts,
   * deploys, or replaces an App that uses a fenced volume. Lock keys name
   * the resource first, as `app:<id>`, then any part of it, as
   * `app:<id>/files`; an App's volume's ID holds a slash of its own.
   */
  refusal(label: string, locks: ReadonlyArray<LaneLock>): string | null {
    if (this.#fences.size === 0 || label === TAR_RESTORE_RECOVERY_LABEL) {
      return null
    }
    for (const lock of locks) {
      for (const [key, journal] of this.#fences) {
        if (lock.key === key || lock.key.startsWith(`${key}/`)) {
          return refusalMessage(journal)
        }
      }
      for (const journal of this.#fences.values()) {
        if (
          journal.target.kind === "volume" &&
          journal.consumers.some(
            (appId) =>
              lock.key === laneKeys.appLifecycle(appId) ||
              (lock.key === laneKeys.app(appId) && lock.mode === "exclusive")
          )
        ) {
          return "An App that uses a volume whose restore didn't finish can't start until the restore finishes"
        }
      }
    }
    return null
  }
}

function refusalMessage(journal: TarRestoreJournal): string {
  return journal.target.kind === "app"
    ? "This App's folder is partway through a restore that didn't finish; the restore must finish first"
    : "This volume is partway through a restore that didn't finish; the restore must finish first"
}

function targetKey(target: { id: string; kind: "app" | "volume" }): string {
  return target.kind === "app"
    ? laneKeys.app(target.id)
    : laneKeys.volume(target.id)
}

function decodeJournal(text: string): TarRestoreJournal | null {
  return Schema.decodeUnknownOption(TarRestoreJournalSchema)(
    safeJson(text)
  ).pipe((option) => (option._tag === "Some" ? option.value : null))
}

function journalDirectory(config: RelayConfig): string {
  return resolve(config.dataDirectory, "restores", "tar")
}

function safeJson(text: string): unknown {
  return Effect.runSync(
    Effect.try({ try: (): unknown => JSON.parse(text), catch: () => null })
  )
}
