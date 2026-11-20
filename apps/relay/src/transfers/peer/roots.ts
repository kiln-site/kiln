import { databaseEngineSupportsLogicalBackups } from "@workspace/contracts"
import { Effect } from "effect"

import {
  dumpCompressedDatabase,
  restoreCompressedDatabaseBackup,
} from "../../database-backups.js"
import type { DatabaseDriver } from "../../databases.js"
import type { FileRoot, FilesystemDriver } from "../../files.js"
import type { LaneLock } from "../../operation-lanes.js"

/** The lane locks a transfer takes on a root, each way. */
export interface TransferRootLocks {
  /**
   * Packing reads the root beside other work and waits only for work that
   * replaces it.
   */
  readonly packLocks: ReadonlyArray<LaneLock>
  /** Installing replaces what's there, so it runs alone. */
  readonly installLocks: ReadonlyArray<LaneLock>
}

/**
 * What a transfer packs from or installs into, as its kind does each: a
 * folder as an archive of its files, a database as its dump.
 */
export interface TransferRoot extends TransferRootLocks {
  /**
   * Packs it into `artifact`, a file not there yet: what is under `paths`,
   * or all of it when there are none.
   */
  readonly pack: (
    paths: ReadonlyArray<string>,
    artifact: string
  ) => Effect.Effect<
    { readonly entries: number; readonly sha256: string; readonly size: number },
    unknown
  >
  /** Installs an artifact another Relay packed, at `path` under the root. */
  readonly install: (
    path: string,
    artifact: string
  ) => Effect.Effect<void, unknown>
  /** The disk a copy of it takes, or null when this Relay can't say. */
  readonly bytes: Effect.Effect<number | null, unknown>
}

export type TransferRootResolver = (rootId: string) => Promise<TransferRoot>

/** A folder: a game server's, an App's, or the host's. */
export function fileTransferRoot(
  filesystem: FilesystemDriver,
  root: FileRoot,
  locks: TransferRootLocks
): TransferRoot {
  return {
    ...locks,
    bytes: filesystem.rootBytes(root),
    install: (path, artifact) =>
      filesystem.installTransferArchive(root, path, artifact),
    pack: (paths, artifact) =>
      filesystem.packTransferArchive(root, paths, artifact),
  }
}

/**
 * A database, which moves as its dump: packing dumps it, as a backup of it
 * does, and installing runs that dump into the database it names, as
 * restoring a backup into another database does. It is copied whole, and
 * must be running at both ends. Refused for an engine Kiln can't dump.
 */
export async function databaseTransferRoot(
  databases: DatabaseDriver,
  databaseId: string,
  locks: TransferRootLocks
): Promise<TransferRoot> {
  const database = await databases.target(databaseId)
  if (!databaseEngineSupportsLogicalBackups(database.engine)) {
    throw new Error(
      `A ${database.engine} database can't be copied between Relays yet`
    )
  }
  const whole = (named: boolean) =>
    named
      ? Effect.fail(new Error("A database is copied whole, not by path"))
      : Effect.void
  return {
    ...locks,
    // Its data's size on disk: more than its dump holds, never less.
    bytes: Effect.tryPromise(() => databases.target(databaseId)).pipe(
      Effect.map((current) => current.diskUsedBytes)
    ),
    install: (path, artifact) =>
      whole(path !== "").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              restoreCompressedDatabaseBackup(databases, databaseId, artifact),
            catch: (cause) => cause,
          })
        ),
        Effect.asVoid
      ),
    pack: (paths, artifact) =>
      whole(paths.length > 0).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) =>
              dumpCompressedDatabase(databases, databaseId, artifact, {
                signal,
              }),
            catch: (cause) => cause,
          })
        ),
        Effect.map((dump) => ({
          entries: 1,
          sha256: dump.checksumSha256,
          size: dump.bytes,
        }))
      ),
  }
}
