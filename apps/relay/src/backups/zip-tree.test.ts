import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { openPromise } from "yauzl"

import { promiseEffect } from "../effect/promise.js"
import { zipTree } from "./zip-tree.js"

const options = { onProgress: () => undefined, totalBytes: 100 }

const withTree = <A, E>(
  use: (root: string, destination: string) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    promiseEffect(() => mkdtemp(join(tmpdir(), "kiln-zip-tree-"))),
    (directory) =>
      promiseEffect(() => mkdir(join(directory, "tree"))).pipe(
        Effect.andThen(use(join(directory, "tree"), join(directory, "out.zip")))
      ),
    (directory) =>
      promiseEffect(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.ignore
      )
  )

const contents = async (path: string) => {
  const zip = await openPromise(path)
  const entries: Record<string, { mode: string; text: string }> = {}
  for await (const entry of zip.eachEntry()) {
    const chunks: Array<Buffer> = []
    if (!entry.fileName.endsWith("/")) {
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        chunks.push(chunk as Buffer)
      }
    }
    entries[entry.fileName] = {
      mode: (entry.externalFileAttributes >>> 16).toString(8),
      text: Buffer.concat(chunks).toString(),
    }
  }
  return entries
}

it.effect("zips files, folders and links as restic does", () =>
  withTree((root, destination) =>
    Effect.gen(function* () {
      yield* promiseEffect(async () => {
        await mkdir(join(root, "world", "empty"), { recursive: true })
        await writeFile(join(root, "start.sh"), "run", { mode: 0o755 })
        await writeFile(join(root, "world", "level.dat"), "level")
        await symlink("start.sh", join(root, "link"))
        // Never read through, wherever it leads.
        await symlink("/etc/passwd", join(root, "outside"))
        await symlink("missing", join(root, "dangling"))
      })
      const zipped = yield* zipTree(root, destination, options)
      const bytes = yield* promiseEffect(() => readFile(destination))
      assert.strictEqual(zipped.bytes, bytes.length)
      assert.strictEqual(
        zipped.checksumSha256,
        createHash("sha256").update(bytes).digest("hex")
      )
      const entries = yield* promiseEffect(() => contents(destination))
      assert.deepStrictEqual(Object.keys(entries).sort(), [
        "dangling",
        "link",
        "outside",
        "start.sh",
        "world/",
        "world/empty/",
        "world/level.dat",
      ])
      assert.deepStrictEqual(entries["start.sh"], {
        mode: "100755",
        text: "run",
      })
      assert.strictEqual(entries["world/level.dat"]?.text, "level")
      assert.strictEqual(entries.link?.text, "start.sh")
      // A link, whatever the platform gives its permissions as.
      assert.match(entries.link?.mode ?? "", /^120/u)
      assert.strictEqual(entries.outside?.text, "/etc/passwd")
    })
  )
)

it.effect("fails when the zip can't be written", () =>
  withTree((root, destination) =>
    Effect.gen(function* () {
      yield* promiseEffect(() => writeFile(join(root, "file"), "content"))
      yield* promiseEffect(() => mkdir(destination))
      yield* Effect.flip(zipTree(root, destination, options))
    })
  )
)
