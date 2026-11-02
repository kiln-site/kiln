/**
 * Holds an upload between checking its target and putting the file in
 * place, the instant another writer could slip into, for tests that race a
 * save against other writers. Test files install it first:
 *
 *   vi.mock("node:fs/promises", async (importOriginal) =>
 *     (await import("./test/held-commit.js")).withHeldCommits(importOriginal)
 *   )
 */
import { basename } from "node:path"
import { onTestFinished } from "vite-plus/test"

type Filesystem = typeof import("node:fs/promises")

let held: { reached: () => void; released: Promise<void> } | null = null

export async function withHeldCommits(
  importOriginal: () => Promise<Filesystem>
): Promise<Filesystem> {
  const filesystem = await importOriginal()
  return {
    ...filesystem,
    rename: async (from, to) => {
      const hold = held
      if (hold && basename(String(from)).startsWith(".kiln-upload-")) {
        held = null
        hold.reached()
        await hold.released
      }
      return filesystem.rename(from, to)
    },
  }
}

/**
 * Holds the next upload that replaces a file. `reached` settles once it has
 * checked the file and waits to replace it, until `release`.
 */
export function holdNextCommit(): {
  readonly reached: Promise<void>
  readonly release: () => void
} {
  let reach = () => {}
  let release = () => {}
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  held = { reached: reach, released }
  onTestFinished(() => {
    held = null
    release()
  })
  return { reached, release }
}
