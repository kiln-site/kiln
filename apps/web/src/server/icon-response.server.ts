import { Effect, Result } from "effect"

import { getIconImageEffect } from "@/effect/icons"
import { runAppEffect } from "@/effect/runtime"
import { iconSubjectSchema } from "@/lib/icons"
import { authorizedIconSubject } from "@/server/icons.server"

// An icon's image. Its URL names its digest, so a browser keeps it until it
// changes. Images came from people and sites Kiln doesn't control, so an
// SVG gets no chance to run anything: it's sandboxed, and never sniffed as
// something else.
const iconHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
}

export async function iconResponse(
  request: Request,
  path: string
): Promise<Response> {
  const segments = path.split("/").map(safeDecode)
  const parsed = iconSubjectSchema.safeParse(
    segments[0] === "user" && segments.length === 2
      ? { kind: "user", id: segments[1] }
      : segments.length === 3
        ? { kind: segments[0], relayId: segments[1], id: segments[2] }
        : null
  )
  if (!parsed.success) return failure(404, "Icon not found")
  const subject = parsed.data
  const allowed = await Effect.runPromise(
    Effect.tryPromise(() => authorizedIconSubject(subject, "read")).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
  )
  if (!allowed) return failure(404, "Icon not found")
  const icon = await runAppEffect("icons.serve", getIconImageEffect(subject))
  const requested = new URL(request.url).searchParams.get("v")
  // Others' pictures load by user ID alone, so whether one exists is kept
  // a few minutes rather than asked on every render.
  if (!icon) {
    return requested === null && subject.kind === "user"
      ? new Response(null, {
          headers: { "Cache-Control": "private, max-age=300" },
          status: 404,
        })
      : failure(404, "Icon not found")
  }
  const etag = `"${icon.digest}"`
  const cacheControl =
    requested === icon.digest
      ? "private, max-age=31536000, immutable"
      : requested === null && subject.kind === "user"
        ? "private, max-age=300"
        : "private, no-cache"
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      headers: { ...iconHeaders, "Cache-Control": cacheControl, ETag: etag },
      status: 304,
    })
  }
  return new Response(new Uint8Array(icon.image), {
    headers: {
      ...iconHeaders,
      "Cache-Control": cacheControl,
      "Content-Length": String(icon.image.byteLength),
      "Content-Type": icon.contentType,
      ETag: etag,
    },
  })
}

function failure(status: number, error: string): Response {
  return Response.json(
    { error },
    { headers: { "Cache-Control": "no-store" }, status }
  )
}

function safeDecode(segment: string): string {
  return Result.try(() => decodeURIComponent(segment)).pipe(
    Result.getOrElse(() => "")
  )
}
