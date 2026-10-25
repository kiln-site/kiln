/**
 * Backup archives fetched through download links Hearth signs:
 * `/v1/browser/backups/<backupId>?token=<capability>`. A link names one
 * backup and works until it expires, so it can be handed to a download
 * manager; ranges let one resume.
 */
import { randomUUID, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { resolve } from "node:path"
import { Effect, Option, Scope } from "effect"

import { backupDownloadCapabilityPayloadSchema } from "@workspace/contracts"

import type { RelayConfig } from "../config.js"
import type { RelayIdentity } from "../effect/identity.js"
import { reportRelayError, runRelayRequest } from "../effect/runtime.js"
import type { RelayStateStore } from "../effect/state.js"
import { actionsForRole } from "../permissions.js"
import type { TransferGate } from "./gate.js"
import {
  contentDisposition,
  parseByteRange,
  reject,
  sendBody,
  TransferRejected,
} from "./http.js"
import { serveTransfer, type TransferResult } from "./serve.js"

const MAX_TOKEN_BYTES = 16 * 1024
const MAX_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000

export interface BackupLinkOptions {
  readonly config: Pick<RelayConfig, "dataDirectory">
  readonly gate: TransferGate
  readonly identity: RelayIdentity
  readonly state: RelayStateStore["Service"]
}

export interface BackupLinks {
  /** Serves a backup download link; false for other requests. */
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<boolean>
}

export function backupLinks(options: BackupLinkOptions): BackupLinks {
  const authenticate = Effect.fn("RelayTransfer.authenticateBackupLink")(
    function* (backupId: string, token: string) {
      const payload = yield* Effect.try(() => {
        if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
          throw new Error("Backup capability is missing")
        }
        const parts = token.split(".")
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error("Backup capability is malformed")
        }
        const payload = backupDownloadCapabilityPayloadSchema.parse(
          JSON.parse(
            Buffer.from(parts[0], "base64url").toString("utf8")
          ) as unknown
        )
        const now = Date.now()
        if (
          payload.backupId !== backupId ||
          payload.audience !== options.identity.fingerprint ||
          payload.expiresAt <= now ||
          payload.issuedAt > now + 5_000 ||
          payload.expiresAt - payload.issuedAt > MAX_TOKEN_LIFETIME_MS
        ) {
          throw new Error("Backup capability scope is invalid")
        }
        return { encoded: parts[0], payload, signature: parts[1] }
      })
      const client = yield* options.state.findClientById(payload.payload.issuer)
      if (
        !client ||
        !actionsForRole(client.role, client.actions).includes("backup.download")
      ) {
        return yield* Effect.fail(
          new Error("Backup capability issuer is unavailable")
        )
      }
      if (
        !verify(
          null,
          Buffer.from(payload.encoded),
          client.publicKey,
          Buffer.from(payload.signature, "base64url")
        )
      ) {
        return yield* Effect.fail(
          new Error("Backup capability signature is invalid")
        )
      }
      return payload.payload
    }
  )

  const serve = (
    request: IncomingMessage,
    response: ServerResponse,
    backupId: string,
    token: string
  ): Effect.Effect<TransferResult | void, unknown, Scope.Scope> =>
    Effect.gen(function* () {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return yield* reject(405, "Method not allowed")
      }
      yield* Effect.annotateCurrentSpan("backup.id", backupId)
      const capability = yield* authenticate(backupId, token).pipe(
        Effect.catch((cause) =>
          reject(401, "Backup download link is invalid", cause)
        )
      )
      yield* options.gate.admit("backup", capability.issuer)

      const archive = yield* findArchive(
        options.config.dataDirectory,
        capability.backupId
      )
      const range = yield* Effect.try({
        try: () => parseByteRange(request.headers.range, archive.size),
        catch: (cause) =>
          new TransferRejected({
            status: 416,
            reason: cause instanceof Error ? cause.message : "Invalid range",
          }),
      })
      response.writeHead(range ? 206 : 200, {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "Accept-Ranges, Content-Disposition, Content-Length, Content-Range",
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(capability.filename),
        "Content-Length": String(
          range ? range.end - range.start + 1 : archive.size
        ),
        "Content-Type": "application/zip",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...(range
          ? {
              "Content-Range": `bytes ${range.start}-${range.end}/${archive.size}`,
            }
          : {}),
      })
      if (request.method === "HEAD") {
        response.end()
        return
      }
      const sent = yield* sendBody(
        createReadStream(archive.path, range ?? undefined),
        response
      )
      yield* options.state
        .appendAudit({
          clientId: capability.issuer,
          details: {
            backupId: capability.backupId,
            bytes: sent.bytes,
            outcome: sent.completed ? "completed" : "aborted",
            permission: "backup.download",
            subject: capability.subject,
          },
          event: "browser.backup.download",
          id: randomUUID(),
          occurredAt: Date.now(),
          requestId: capability.capabilityId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              reportRelayError(cause, { operation: "backup.download.audit" })
            })
          )
        )
      return { ...sent, direction: "sent" } satisfies TransferResult
    })

  return {
    handleRequest: async (request, response) => {
      const url = new URL(request.url ?? "/", "http://relay")
      const match = url.pathname.match(/^\/v1\/browser\/backups\/([^/]+)$/u)
      if (!match) return false
      const backupId = Option.getOrUndefined(
        Option.liftThrowable(decodeURIComponent)(match[1] ?? "")
      )
      await runRelayRequest(
        serveTransfer({
          route: "backup.download",
          request,
          response,
          program:
            backupId === undefined
              ? reject(400, "Backup path is invalid")
              : serve(
                  request,
                  response,
                  backupId,
                  url.searchParams.get("token") ?? ""
                ),
        })
      )
      return true
    },
  }
}

/** A backup kept on this Relay, or one exported here from elsewhere. */
const findArchive = Effect.fnUntraced(function* (
  dataDirectory: string,
  backupId: string
) {
  for (const folder of ["backups", "exports"]) {
    const path = resolve(dataDirectory, folder, `${backupId}.zip`)
    const metadata = yield* Effect.tryPromise(() => lstat(path)).pipe(
      Effect.option
    )
    if (
      Option.isSome(metadata) &&
      metadata.value.isFile() &&
      !metadata.value.isSymbolicLink()
    ) {
      return { path, size: metadata.value.size }
    }
  }
  return yield* reject(404, "Backup archive is unavailable")
})
