import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, readdir, readlink } from "node:fs/promises"
import { join } from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { constants as zlibConstants } from "node:zlib"

import { ZipArchiveEntry, ZipArchiveOutputStream } from "compress-commons"
import { Data, Effect } from "effect"

import { promiseEffect } from "../effect/promise.js"

/** Something this writer can't put in a zip as it is. */
export class UnzippableEntryError extends Data.TaggedError(
  "UnzippableEntryError"
)<{ readonly name: string }> {}

/**
 * Writes everything under `root` to a new zip, as `restic dump` writes a
 * snapshot: folders and links too, with their modes and times. It fails
 * rather than leave something out or name it otherwise.
 */
export function zipTree(
  root: string,
  destination: string,
  options: { onProgress: (bytes: number) => void; totalBytes: number }
): Effect.Effect<{ bytes: number; checksumSha256: string }, unknown> {
  return Effect.suspend(() => {
    // Its types leave out its own options.
    const zipOptions: object = {
      // Some tools can't read it, and only a file over 4 GiB needs it.
      forceZip64: options.totalBytes > 0xffff_ffff,
      zlib: { level: zlibConstants.Z_BEST_SPEED },
    }
    const archive = new ZipArchiveOutputStream(zipOptions)
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
    const add = (
      name: string,
      open: () => Readable | Buffer,
      metadata: { mode: number; mtime: Date },
      stored: boolean
    ) =>
      Effect.suspend(() => {
        const entry = new ZipArchiveEntry()
        entry.setName(name)
        // It drops a drive letter and turns backslashes, which Linux allows
        // in a name, so one file could take another's place.
        if (entry.getName() !== name) {
          return Effect.fail(new UnzippableEntryError({ name }))
        }
        entry.setTime(metadata.mtime)
        // A large entry's sizes take the place of what `setExtra` was given.
        const modified = modifiedField(metadata.mtime)
        const extra = () => Buffer.concat([entry.getExtra(), modified])
        entry.getLocalFileDataExtra = extra
        entry.getCentralDirectoryExtra = extra
        entry.setUnixMode(metadata.mode)
        if (stored) entry.setMethod(0)
        return Effect.callback<void, Error>((resume) => {
          const source = open()
          archive.entry(entry, source, (cause) => {
            resume(cause ? Effect.fail(cause) : Effect.void)
          })
          return Effect.sync(() => {
            if (!Buffer.isBuffer(source)) source.destroy()
          })
        })
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
          if (metadata.isDirectory()) {
            yield* add(`${name}/`, () => Buffer.alloc(0), metadata, true)
            yield* visit(path, `${name}/`)
          } else if (metadata.isSymbolicLink()) {
            const target = yield* promiseEffect(() => readlink(path))
            yield* add(name, () => Buffer.from(target), metadata, true)
          } else if (metadata.isFile()) {
            yield* add(name, () => createReadStream(path), metadata, false)
          } else {
            return yield* new UnzippableEntryError({ name })
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
      Effect.andThen(Effect.sync(() => archive.finish()))
    )
    return Effect.all([write, read], { concurrency: 2, discard: true }).pipe(
      Effect.map(() => ({ bytes, checksumSha256: digest.digest("hex") }))
    )
  })
}

// The zip's own times are in no time zone; this extended timestamp, as restic
// also writes, is in UTC.
function modifiedField(modifiedAt: Date): Buffer {
  const field = Buffer.alloc(9)
  field.writeUInt16LE(0x5455, 0)
  field.writeUInt16LE(5, 2)
  field.writeUInt8(1, 4)
  field.writeInt32LE(Math.trunc(modifiedAt.getTime() / 1_000) | 0, 5)
  return field
}
