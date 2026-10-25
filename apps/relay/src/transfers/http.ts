/**
 * The HTTP pieces every direct transfer shares: refusals, byte ranges,
 * download headers, bounded request bodies, and streaming a body to the
 * response as an effect that ends with how many bytes it sent.
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Readable } from "node:stream"
import { Effect, Schema } from "effect"

/** A transfer the Relay refuses, answered with `status` and `reason`. */
export class TransferRejected extends Schema.TaggedError<TransferRejected>()(
  "TransferRejected",
  {
    status: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export const reject = (status: number, reason: string, cause?: unknown) =>
  Effect.fail(
    new TransferRejected({
      status,
      reason,
      ...(cause === undefined ? {} : { cause }),
    })
  )

export interface ByteRange {
  readonly end: number
  readonly start: number
}

/**
 * The single byte range a `Range` header asks for, clamped to the body as
 * RFC 9110 allows, or null for the whole body. Several ranges, or one that
 * starts past the end, are refused.
 */
export function parseByteRange(
  value: string | undefined,
  size: number
): ByteRange | null {
  if (!value) return null
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Requested byte range is invalid")
  }
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/u)
  if (!match) throw new Error("Only a single byte range is supported")
  if (!match[1] && !match[2]) throw new Error("Requested byte range is invalid")
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new Error("Requested byte range is invalid")
    }
    return { end: size - 1, start: Math.max(0, size - suffixLength) }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  const end = Math.min(requestedEnd, size - 1)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new Error("Requested byte range is invalid")
  }
  return { end, start }
}

export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._-]/gu, "_") || "download"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** A download's file name: one path segment without control characters. */
export function normalizedDownloadName(
  requestedName: string | undefined,
  fallback: string
): string {
  const name = requestedName?.trim() || fallback
  if (
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        codePoint < 32 ||
        codePoint === 127 ||
        character === "/" ||
        character === "\\"
      )
    })
  ) {
    throw new Error("Download name is invalid")
  }
  return name
}

/** A request header, refused when missing or oversized. */
export function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  if (typeof value !== "string" || !value || value.length > 8_192) {
    throw new Error(`${name} header is invalid`)
  }
  return value
}

/** Reads a small request body whole, failing once it passes `maxBytes`. */
export const readBoundedBody = Effect.fnUntraced(function* (
  request: IncomingMessage,
  maxBytes: number
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.byteLength
        if (size > maxBytes) throw new Error("Request body is too large")
        chunks.push(bytes)
      }
      return Buffer.concat(chunks)
    },
    catch: (cause) => cause,
  })
})

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.destroyed || response.writableEnded) return
  response
    .writeHead(status, {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(value))
}

/** How a streamed body ended: sent whole, or cut off by the client. */
export interface SentBody {
  readonly bytes: number
  readonly completed: boolean
}

/**
 * Streams `body` to `response` and ends with the bytes sent. A client that
 * goes away ends it as incomplete; a failing body fails it and destroys the
 * response. Interrupting it destroys both.
 */
export function sendBody(
  body: Readable,
  response: ServerResponse
): Effect.Effect<SentBody, Error> {
  return Effect.callback<SentBody, Error>((resume) => {
    let bytes = 0
    let settled = false
    const cleanup = () => {
      body.off("error", failed)
      body.off("data", counted)
      response.off("finish", finished)
      response.off("close", closed)
    }
    const settle = (effect: Effect.Effect<SentBody, Error>) => {
      if (settled) return
      settled = true
      cleanup()
      resume(effect)
    }
    const counted = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk)
    }
    const failed = (cause: Error) => {
      body.destroy()
      if (!response.destroyed) response.destroy(cause)
      settle(Effect.fail(cause))
    }
    const finished = () => settle(Effect.succeed({ bytes, completed: true }))
    const closed = () => {
      body.destroy()
      settle(Effect.succeed({ bytes, completed: false }))
    }
    body.once("error", failed)
    body.on("data", counted)
    response.once("finish", finished)
    response.once("close", closed)
    body.pipe(response)
    return Effect.sync(() => {
      if (settled) return
      settled = true
      cleanup()
      body.destroy()
      if (!response.destroyed) response.destroy()
    })
  })
}

/** A short message safe to show the person a failed transfer was for. */
export function transferFailureMessage(cause: unknown): string {
  if (cause instanceof TransferRejected) return cause.reason
  if (!cause || typeof cause !== "object" || !("message" in cause)) {
    return "File transfer failed"
  }
  const message = cause.message
  return typeof message === "string" && message.length <= 200
    ? message
    : "File transfer failed"
}
