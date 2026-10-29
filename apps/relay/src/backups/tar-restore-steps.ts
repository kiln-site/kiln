import {
  chmod,
  lchown,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"

/**
 * The steps that swap a restored copy in for what a volume or an App's
 * folder held. Docker extracts the restore into a staging folder inside it,
 * so the old files stay until the copy is whole; these steps then run in a
 * helper container that mounts it, as root, since Docker's archive API
 * extracts but can't remove or move anything.
 *
 * `reserve` makes the staging folder, failing if anything has its name, so
 * the other steps only ever remove or move what the restore put there.
 * Each later step is safe to run again after an interruption: `clear`
 * removes only what isn't the staging folder, and `install` moves only
 * what's still in it. Nothing follows a symlink: removing one removes the
 * link, and renames move links as they are.
 */
export type TarRestoreStep = "clear" | "discard" | "install" | "reserve"

/** The owner and mode the restored root takes, from its archived entry. */
export interface TarRestoreRoot {
  readonly gid: number
  readonly mode: number
  readonly uid: number
  /** Its extended attributes, as the archive's PAX records name them. */
  readonly xattrs?: Readonly<Record<string, string>> | undefined
}

const STAGING =
  /^\.kiln-restore-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Names at a target's root that restores keep for their staging folders. */
export const TAR_RESTORE_STAGING_PREFIX = ".kiln-restore-"

/** The staging folder's name for a restore task. */
export function tarRestoreStagingName(taskId: string): string {
  return `${TAR_RESTORE_STAGING_PREFIX}${taskId}`
}

export async function runTarRestoreStep(
  root: string,
  step: TarRestoreStep,
  staging: string,
  owner: TarRestoreRoot | null
): Promise<void> {
  if (!STAGING.test(staging)) throw new Error("Invalid staging folder")
  const stagingPath = join(root, staging)
  switch (step) {
    case "reserve":
      // Never one already there, which the restore didn't make.
      await mkdir(stagingPath, { mode: 0o700 })
      return
    case "discard":
      await rm(stagingPath, { force: true, recursive: true })
      return
    case "clear":
      // Without a whole staging folder there's nothing to restore, so the
      // old files stay.
      await requireStagingFolder(stagingPath)
      for (const name of await readdir(root)) {
        if (name === staging) continue
        await rm(join(root, name), { force: true, recursive: true })
      }
      return
    case "install": {
      const remaining = await optionalEntries(stagingPath)
      for (const name of remaining ?? []) {
        // Staging validates every path; this one would replace the folder.
        if (name.startsWith(TAR_RESTORE_STAGING_PREFIX)) {
          throw new Error("The restore holds a staging folder's name")
        }
        const target = join(root, name)
        // Only what a container wrote since clearing, which the restore's
        // locks keep from happening, or a move cut off midway.
        await rm(target, { force: true, recursive: true })
        await rename(join(stagingPath, name), target)
      }
      if (remaining) await rmdir(stagingPath)
      if (owner) {
        await lchown(root, owner.uid, owner.gid)
        await chmod(root, owner.mode & 0o7777)
      }
      return
    }
  }
}

async function requireStagingFolder(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) throw new Error("The restore isn't staged")
}

// A folder's entries, or null when it's gone, as after a finished install.
async function optionalEntries(path: string): Promise<Array<string> | null> {
  const metadata = await Effect.runPromise(
    Effect.tryPromise({ try: () => lstat(path), catch: (cause) => cause }).pipe(
      Effect.catchIf(
        (cause) =>
          cause instanceof Error && "code" in cause && cause.code === "ENOENT",
        () => Effect.succeed(null)
      )
    )
  )
  if (metadata === null) return null
  if (!metadata.isDirectory()) throw new Error("The restore isn't staged")
  return readdir(path)
}
