import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vite-plus/test"

import {
  runTarRestoreStep,
  tarRestoreStagingName,
} from "./tar-restore-steps.js"

const taskId = "0b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e"
const staging = tarRestoreStagingName(taskId)
const directories: Array<string> = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-tar-steps-"))
  directories.push(directory)
  const root = join(directory, "volume")
  const outside = join(directory, "outside")
  await mkdir(join(root, staging, "db"), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, "keep.txt"), "not the volume's")
  await writeFile(join(root, "old.txt"), "old")
  // A link out of the volume, as a container may leave.
  await symlink(outside, join(root, "escape"))
  await writeFile(join(root, staging, "db", "rows"), "restored")
  await writeFile(join(root, staging, "new.txt"), "new")
  return { outside, root }
}

it("clears what the volume held without following links out of it, then moves the restore in", async () => {
  const { outside, root } = await scratch()

  await runTarRestoreStep(root, "clear", staging, null)
  await runTarRestoreStep(root, "install", staging, null)

  expect((await readdir(root)).sort()).toEqual(["db", "new.txt"])
  expect(await readFile(join(root, "db", "rows"), "utf8")).toBe("restored")
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe(
    "not the volume's"
  )
})

it("finishes an install cut off midway when run again, and refuses to clear what isn't staged", async () => {
  const { root } = await scratch()
  await runTarRestoreStep(root, "clear", staging, null)
  // Moved before the stop, as a rename that finished.
  await rm(join(root, staging, "new.txt"))
  await writeFile(join(root, "new.txt"), "new")

  await runTarRestoreStep(root, "install", staging, null)
  await runTarRestoreStep(root, "install", staging, null)

  expect((await readdir(root)).sort()).toEqual(["db", "new.txt"])
  // With the staging folder gone, clearing would leave nothing to restore.
  await expect(
    runTarRestoreStep(root, "clear", staging, null)
  ).rejects.toThrow()
  expect((await readdir(root)).sort()).toEqual(["db", "new.txt"])
  await expect(
    runTarRestoreStep(root, "discard", "../outside", null)
  ).rejects.toThrow("Invalid staging folder")
})
