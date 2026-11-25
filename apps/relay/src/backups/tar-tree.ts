import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, readdir, readlink } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip, createZstdCompress } from "node:zlib"

import { Effect } from "effect"
import { pack as tarPack, type Header } from "tar-stream"

import { promiseEffect } from "../effect/promise.js"

/**
 * Writes everything under `root` to a new compressed tar: folders, files and
 * links, with their owners, modes and times. Anything else, as a pipe, is
 * left out.
 */
export function tarTree(
  root: string,
  destination: string,
  options: {
    compression: "gzip" | "zstd"
    onProgress: (bytes: number) => void
  }
): Effect.Effect<{ bytes: number; checksumSha256: string }, unknown> {
  return Effect.suspend(() => {
    const pack = tarPack()
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
      header: Partial<Header> & Pick<Header, "name">,
      body?: () => Readable
    ) =>
      Effect.callback<void, Error>((resume) => {
        const done = (cause?: Error | null) =>
          resume(cause ? Effect.fail(cause) : Effect.void)
        const source = body?.()
        const sink = pack.entry(header, done)
        if (!source) return
        source.once("error", (cause) => pack.destroy(cause))
        source.pipe(sink as unknown as NodeJS.WritableStream)
        return Effect.sync(() => source.destroy())
      })
    // Files already in it, by their inode, for its other names.
    const links = new Map<string, string>()
    const visit = (
      directory: string,
      prefix: string
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const children = yield* promiseEffect(() => readdir(directory))
        for (const child of children.sort()) {
          const path = join(directory, child)
          const name = `${prefix}${child}`
          const metadata = yield* promiseEffect(() => lstat(path))
          const header = {
            gid: metadata.gid,
            mode: metadata.mode & 0o7777,
            mtime: metadata.mtime,
            uid: metadata.uid,
          }
          if (metadata.isDirectory()) {
            yield* add({ ...header, name: `${name}/`, type: "directory" })
            yield* visit(path, `${name}/`)
          } else if (metadata.isSymbolicLink()) {
            const linkname = yield* promiseEffect(() => readlink(path))
            yield* add({ ...header, linkname, name, type: "symlink" })
          } else if (metadata.isFile()) {
            const inode = `${metadata.dev}:${metadata.ino}`
            const linkname = links.get(inode)
            if (linkname !== undefined) {
              yield* add({ ...header, linkname, name, type: "link" })
              continue
            }
            if (metadata.nlink > 1) links.set(inode, name)
            yield* add(
              { ...header, name, size: metadata.size, type: "file" },
              () => createReadStream(path)
            )
          }
        }
      })
    const write = Effect.tryPromise({
      try: (signal) =>
        pipeline(
          Readable.from(pack),
          options.compression === "zstd"
            ? createZstdCompress()
            : createGzip({ level: 6 }),
          meter,
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
          { signal }
        ),
      catch: (cause) => cause,
    })
    const read = visit(root, "").pipe(
      Effect.andThen(Effect.sync(() => pack.finalize()))
    )
    return Effect.all([write, read], { concurrency: 2, discard: true }).pipe(
      Effect.map(() => ({ bytes, checksumSha256: digest.digest("hex") }))
    )
  })
}
