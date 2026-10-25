/**
 * The bodies a download sends: a file or part of one, a file compressed on
 * the way out, or a zip of several. Each is one readable stream whose
 * failures surface on it, so `sendBody` can stream any of them.
 */
import { createReadStream } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { pipeline, type Readable } from "node:stream"
import {
  constants as zlibConstants,
  createGzip,
  deflateRawSync,
  gzipSync,
} from "node:zlib"
import { Effect } from "effect"
import ZipStream from "zip-stream"

import type { ArchiveDownloadEntry } from "../files.js"
import type { ByteRange } from "./http.js"

export type DownloadCompression = "gzip" | "none" | "zip"

// Compressed size estimates read at most this much of the file.
const COMPRESSION_SAMPLE_BYTES = 1024 * 1024

/**
 * An open file's contents, or `range` of them, compressed as asked. The
 * file stays open; its owner closes it.
 */
export function fileBody(input: {
  readonly compression: DownloadCompression
  readonly file: FileHandle
  readonly name: string
  readonly range: ByteRange | null
  readonly size: number
}): Readable {
  const source = input.file.createReadStream(
    input.range
      ? { autoClose: false, end: input.range.end, start: input.range.start }
      : { autoClose: false }
  )
  if (input.compression === "gzip") {
    return pipeline(
      source,
      createGzip({ level: zlibConstants.Z_BEST_SPEED }),
      () => undefined
    )
  }
  if (input.compression === "zip") {
    const archive = zipStream(input.size > 0xffffffff)
    archive.on("close", () => source.destroy())
    archive.entry(source, { name: input.name }, (cause) => {
      if (cause) archive.destroy(cause)
      else archive.finalize()
    })
    return archive
  }
  return source
}

/** A zip of `entries`, read one file at a time as the archive is sent. */
export function archiveBody(
  entries: ReadonlyArray<ArchiveDownloadEntry>
): Readable {
  const archive = zipStream(entries.some((entry) => entry.size > 0xffffffff))
  let active: Readable | null = null
  archive.on("close", () => active?.destroy())
  const append = (index: number) => {
    if (archive.destroyed) return
    const entry = entries[index]
    if (!entry) {
      archive.finalize()
      return
    }
    if (entry.kind === "directory") {
      archive.entry(null, { name: `${entry.name}/` }, (cause) => {
        if (cause) archive.destroy(cause)
        else append(index + 1)
      })
      return
    }
    const source = createReadStream(entry.absolute)
    active = source
    source.once("error", (cause) => archive.destroy(cause))
    archive.entry(source, { name: entry.name }, (cause) => {
      active = null
      if (cause) archive.destroy(cause)
      else append(index + 1)
    })
  }
  append(0)
  return archive
}

/**
 * What a file would compress to as gzip and as zip, from its first
 * megabyte, so a person can choose before downloading.
 */
export const estimateCompressedSizes = Effect.fn(
  "RelayTransfer.estimateCompression"
)(function* (file: FileHandle, name: string, size: number) {
  const zipOverhead =
    114 + Buffer.byteLength(name) * 2 + (size > 0xffffffff ? 98 : 0)
  const sampleSize = Math.min(size, COMPRESSION_SAMPLE_BYTES)
  const sample = Buffer.allocUnsafe(sampleSize)
  const { bytesRead } =
    sampleSize === 0
      ? { bytesRead: 0 }
      : yield* Effect.tryPromise(() => file.read(sample, 0, sampleSize, 0))
  if (bytesRead === 0) {
    const gzip = gzipSync(Buffer.alloc(0), {
      level: zlibConstants.Z_BEST_SPEED,
    }).byteLength
    return { gzip, zip: zipOverhead }
  }
  const contents = sample.subarray(0, bytesRead)
  const gzipSize = gzipSync(contents, {
    level: zlibConstants.Z_BEST_SPEED,
  }).byteLength
  const zipSize = deflateRawSync(contents, {
    level: zlibConstants.Z_BEST_SPEED,
  }).byteLength
  return {
    gzip: Math.ceil((gzipSize / bytesRead) * size),
    zip: Math.ceil((zipSize / bytesRead) * size) + zipOverhead,
  }
})

function zipStream(forceZip64: boolean): ZipStream {
  return new ZipStream({
    forceZip64,
    zlib: { level: zlibConstants.Z_BEST_SPEED },
  })
}
