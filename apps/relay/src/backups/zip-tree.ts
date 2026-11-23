import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, readdir, readlink } from "node:fs/promises"
import { join } from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { constants as zlibConstants } from "node:zlib"

import { Effect } from "effect"
import ZipStream, { type FileDataInput } from "zip-stream"

import { promiseEffect } from "../effect/promise.js"

/**
 * Writes everything under `root` to a new zip, as `restic dump` writes a
 * snapshot: folders and links too, with their modes and times.
 */
export function zipTree(
  root: string,
  destination: string,
  options: { onProgress: (bytes: number) => void; totalBytes: number }
): Effect.Effect<{ bytes: number; checksumSha256: string }, unknown> {
  return Effect.suspend(() => {
    const archive = new ZipStream({
      // Some tools can't read it, and only a file over 4 GiB needs it.
      forceZip64: options.totalBytes > 0xffff_ffff,
      zlib: { level: zlibConstants.Z_BEST_SPEED },
    })
    const digest = createHash("sha256")
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength
        digest.update(chunk)
        options.onProgress(bytes)
        callback(null, chunk)
      },
    })
    const add = (source: Readable | null, entry: FileDataInput) =>
      Effect.callback<void, Error>((resume) => {
        archive.entry(source, entry, (cause) => {
          resume(cause ? Effect.fail(cause) : Effect.void)
        })
        return Effect.sync(() => source?.destroy())
      })
    const visit = (
      directory: string,
      prefix: string
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const children = yield* promiseEffect(() => readdir(directory))
        for (const child of children.sort()) {
          const path = join(directory, child)
          const metadata = yield* promiseEffect(() => lstat(path))
          const name = `${prefix}${child}`
          const entry = { date: metadata.mtime, mode: metadata.mode, name }
          if (metadata.isDirectory()) {
            yield* add(null, { ...entry, name: `${name}/`, type: "directory" })
            yield* visit(path, `${name}/`)
          } else if (metadata.isSymbolicLink()) {
            const linkname = yield* promiseEffect(() => readlink(path))
            yield* add(null, { ...entry, linkname, type: "symlink" })
          } else if (metadata.isFile()) {
            yield* add(createReadStream(path), entry)
          }
        }
      })
    const write = Effect.tryPromise({
      try: (signal) =>
        pipeline(
          archive,
          meter,
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
          { signal }
        ),
      catch: (cause) => cause,
    })
    const read = visit(root, "").pipe(
      Effect.andThen(Effect.sync(() => archive.finalize()))
    )
    return Effect.all([write, read], { concurrency: 2, discard: true }).pipe(
      Effect.map(() => ({ bytes, checksumSha256: digest.digest("hex") }))
    )
  })
}
