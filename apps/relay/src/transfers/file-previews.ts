/**
 * File previews: `/v1/browser/previews/<root>?path=<path>&token=<capability>`
 * plays a game server's, App's, database's, or the host's audio or video in
 * the browser's own player. A player can't sign each request it makes, so
 * the capability Hearth signed travels in the link and no proof is asked:
 * it names one file, only reads it, and only as a media type the Relay
 * serves inline. Ranges let the player seek. Revoking the person's access,
 * or the Hearth's, refuses new requests and cuts off those under way.
 */
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Effect, Result, Scope } from "effect"

import {
  browserAuthority,
  decodeCapability,
  validateCapability,
} from "../browser-capability.js"
import { reportRelayError } from "../effect/runtime.js"
import { fileTransferAction } from "../permissions.js"
import { fileBody } from "./bodies.js"
import type { FileRoot, FilesystemDriver } from "../files.js"
import type { BrowserFileTransferOptions } from "./browser-files.js"
import {
  contentDisposition,
  parseByteRange,
  reject,
  sendBody,
  TransferRejected,
} from "./http.js"
import type { TransferResult } from "./serve.js"

const MAX_TOKEN_BYTES = 16 * 1024

// What a preview serves, by extension. Anything else isn't served inline, so
// the Relay never hands a browser a page or script of its own origin.
const previewTypes: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
}

// Preview links audited lately, so each is recorded once however many
// ranges its player reads, while staying bounded.
const MAX_AUDITED_PREVIEWS = 4_096

export interface PreviewAudits {
  /** Whether this read is the first of its link, which is then recorded. */
  readonly claim: (capabilityId: string, expiresAt: number) => boolean
}

export function previewAudits(): PreviewAudits {
  const audited = new Map<string, number>()
  return {
    claim: (capabilityId, expiresAt) => {
      const now = Date.now()
      for (const [id, expires] of audited) {
        if (expires <= now) audited.delete(id)
      }
      if (audited.has(capabilityId)) return false
      // Past the bound, the oldest is forgotten; a link is at most recorded
      // again, never skipped.
      if (audited.size >= MAX_AUDITED_PREVIEWS) {
        const oldest = audited.keys().next().value
        if (oldest !== undefined) audited.delete(oldest)
      }
      audited.set(capabilityId, expiresAt)
      return true
    },
  }
}

export function previewTypeForPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? previewTypes[name.slice(dot + 1).toLowerCase()] : undefined
}

/** What the preview route shares with the Relay's other browser transfers. */
export interface PreviewRoute {
  readonly audits: PreviewAudits
  /** Bounds how many requests authenticate at once, and for how long. */
  readonly authenticate: <A, E, R>(
    request: IncomingMessage,
    work: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | TransferRejected, R>
  readonly resolveRoot: (
    rootId: string
  ) => Effect.Effect<
    { filesystem: FilesystemDriver; root: FileRoot } | null,
    unknown
  >
}

export function serveFilePreview(
  options: BrowserFileTransferOptions,
  { audits, authenticate, resolveRoot }: PreviewRoute,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  encodedRootId: string
): Effect.Effect<TransferResult | void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return yield* reject(405, "Method not allowed")
    }
    const method = request.method
    const decodedRootId = Result.try(() => decodeURIComponent(encodedRootId))
    if (Result.isFailure(decodedRootId)) {
      return yield* reject(400, "Instance path is invalid")
    }
    const rootId = decodedRootId.success
    const path = url.searchParams.get("path") ?? ""
    const type = previewTypeForPath(path)
    if (!type) return yield* reject(415, "This file can't be previewed")

    const clientConfiguration = options.registry.clientConfiguration
    const authentication = yield* authenticate(
      request,
      authenticatePreview(
        options,
        url.searchParams.get("token") ?? "",
        rootId,
        path
      ).pipe(
        Effect.catch((cause) => reject(401, "Preview link is invalid", cause))
      )
    )
    if (clientConfiguration !== options.registry.clientConfiguration) {
      return yield* reject(401, "Preview link is invalid")
    }

    yield* options.gate.admit("browser", authentication.clientId)
    const transfer = yield* Effect.acquireRelease(
      Effect.sync(() =>
        options.registry.registerTransfer(
          authentication.authority,
          authentication.current,
          () => {
            if (!request.destroyed) request.destroy()
            if (!response.destroyed) response.destroy()
          }
        )
      ),
      (registered) => Effect.sync(() => registered.release())
    )
    if (!transfer.active()) {
      return yield* reject(403, "Browser authorization changed")
    }

    const target = yield* resolveRoot(rootId)
    if (!target) return yield* reject(404, "Instance not found")
    yield* Effect.annotateCurrentSpan("kiln.transfer.operation", "preview")

    const sent = yield* target.filesystem.withDownload(
      target.root,
      path,
      (download) =>
        Effect.gen(function* () {
          const range = yield* Effect.try({
            try: () => parseByteRange(request.headers.range, download.size),
            catch: (cause) =>
              new TransferRejected({
                status: 416,
                reason:
                  cause instanceof Error ? cause.message : "Invalid range",
              }),
          })
          response.writeHead(range ? 206 : 200, {
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": authentication.origin,
            "Cache-Control": "private, no-store",
            "Content-Disposition": contentDisposition(download.name).replace(
              /^attachment/u,
              "inline"
            ),
            "Content-Length": String(
              range ? range.end - range.start + 1 : download.size
            ),
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Type": type,
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Last-Modified": new Date(download.modifiedAt).toUTCString(),
            "Referrer-Policy": "no-referrer",
            Vary: "Origin",
            "X-Content-Type-Options": "nosniff",
            ...(range
              ? {
                  "Content-Range": `bytes ${range.start}-${range.end}/${download.size}`,
                }
              : {}),
          })
          if (method === "HEAD") {
            response.end()
            return { bytes: 0, completed: true }
          }
          return yield* sendBody(
            fileBody({
              compression: "none",
              file: download.file,
              name: download.name,
              range,
              size: download.size,
            }),
            response
          )
        }).pipe(
          // A player asks for many ranges as it seeks; each link's reads are
          // recorded once, from whichever range comes first.
          Effect.tap((sent) =>
            method === "GET" &&
            audits.claim(authentication.capabilityId, authentication.expiresAt)
              ? audit(options, authentication, sent)
              : Effect.void
          )
        )
    )
    return { ...sent, direction: "sent" } satisfies TransferResult
  })
}

const authenticatePreview = Effect.fn("RelayTransfer.authenticatePreview")(
  function* (
    options: BrowserFileTransferOptions,
    token: string,
    rootId: string,
    path: string
  ) {
    const parsed = yield* Effect.try(() => {
      if (!token || token.length > MAX_TOKEN_BYTES) {
        throw new Error("Preview link is missing")
      }
      return decodeCapability(token)
    })
    const payload = parsed.payload
    if (payload.version !== 2 || payload.operation !== "preview") {
      return yield* Effect.fail(new Error("Capability is not for previews"))
    }
    const client = yield* options.state.findClientById(payload.issuer)
    if (!client) {
      return yield* Effect.fail(new Error("Capability issuer was revoked"))
    }
    yield* Effect.try(() => {
      // A player's requests carry no origin to check, so the link is held to
      // the origin it was issued for, which the client must still trust.
      validateCapability(
        parsed,
        client,
        payload.origin,
        options.identity.id,
        fileTransferAction(rootId, "download")
      )
      if (payload.instanceId !== rootId || payload.path !== path) {
        throw new Error("Capability scope does not match the file")
      }
    })
    const current = yield* options.state.browserAuthority({
      instanceId: payload.instanceId,
      issuer: payload.issuer,
      loginSessionId: payload.loginSessionId,
      subject: payload.subject,
    })
    if (
      payload.issuerGeneration !== current.issuerGeneration ||
      payload.authorizationRevision < current.minimumRevision
    ) {
      return yield* Effect.fail(new Error("Browser authorization is stale"))
    }
    return {
      authority: browserAuthority(payload),
      capabilityId: payload.capabilityId,
      clientId: client.id,
      current,
      expiresAt: payload.expiresAt,
      instanceId: payload.instanceId,
      origin: payload.origin,
      subject: payload.subject,
    }
  }
)

const audit = (
  options: BrowserFileTransferOptions,
  authentication: {
    readonly capabilityId: string
    readonly clientId: string
    readonly instanceId: string
    readonly subject: string
  },
  sent: { readonly bytes: number; readonly completed: boolean }
) =>
  options.state
    .appendAudit({
      clientId: authentication.clientId,
      details: {
        bytes: sent.bytes,
        instanceId: authentication.instanceId,
        method: "GET",
        outcome: sent.completed ? "completed" : "aborted",
        permission: fileTransferAction(authentication.instanceId, "download"),
        preview: true,
        subject: authentication.subject,
      },
      event: "browser.file.download",
      id: randomUUID(),
      occurredAt: Date.now(),
      requestId: authentication.capabilityId,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          reportRelayError(cause, { operation: "browser.file.preview.audit" })
        })
      )
    )
