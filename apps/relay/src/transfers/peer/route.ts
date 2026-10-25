/**
 * `/v1/peer/transfers/<transferId>`: where another Relay fetches an
 * artifact this Relay packed. A request carries the grant Hearth signed for
 * that Relay and a proof signed with the Relay's identity key, so a grant is
 * useless to anyone else; ranges let an interrupted pull resume.
 */
import { createPublicKey, randomUUID, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Clock, Effect, Option, Schema, Scope } from "effect"

import {
  RelayPeerTransferGrantSchema,
  relayPeerTransferProofTranscript,
  type RelayPeerTransferGrant,
} from "@workspace/contracts"

import { fingerprint, type RelayIdentity } from "../../effect/identity.js"
import {
  reportRelayError,
  runRelayRequest,
  traceParentSpan,
} from "../../effect/runtime.js"
import type { RelayStateStore } from "../../effect/state.js"
import { actionsForRole, fileTransferAction } from "../../permissions.js"
import type { TransferGate } from "../gate.js"
import {
  parseByteRange,
  reject,
  requiredHeader,
  sendBody,
  TransferRejected,
} from "../http.js"
import { serveTransfer, type TransferResult } from "../serve.js"
import type { TransferSources } from "./sources.js"

const MAX_GRANT_BYTES = 16 * 1024
const MAX_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60_000
const PROOF_WINDOW_MS = 60_000
const MAX_REMEMBERED_NONCES = 10_000

export interface PeerTransferRouteOptions {
  readonly gate: TransferGate
  readonly identity: RelayIdentity
  readonly sources: TransferSources
  readonly state: RelayStateStore["Service"]
}

export interface PeerTransferRoute {
  /** Serves a peer's artifact request; false for other requests. */
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<boolean>
}

export function peerTransferRoute(
  options: PeerTransferRouteOptions
): PeerTransferRoute {
  // Proofs already used, until they'd be stale anyway.
  const nonces = new Map<string, number>()

  const authenticate = Effect.fn("RelayTransfer.authenticatePeer")(function* (
    request: IncomingMessage,
    method: "GET" | "HEAD",
    transferId: string
  ) {
    const now = yield* Clock.currentTimeMillis
    const credentials = yield* Effect.try(() => {
      const authorization = requiredHeader(request, "authorization")
      if (!authorization.startsWith("KilnPeer ")) {
        throw new Error("Missing transfer grant")
      }
      const token = authorization.slice("KilnPeer ".length)
      if (Buffer.byteLength(token) > MAX_GRANT_BYTES) {
        throw new Error("Transfer grant is too large")
      }
      const [encoded, signature, extra] = token.split(".")
      if (!encoded || !signature || extra !== undefined) {
        throw new Error("Transfer grant is malformed")
      }
      const grant = Schema.decodeUnknownSync(
        Schema.fromJsonString(RelayPeerTransferGrantSchema)
      )(Buffer.from(encoded, "base64url").toString("utf8"))
      return {
        encoded,
        grant,
        nonce: requiredHeader(request, "x-kiln-nonce"),
        peerKey: Buffer.from(
          requiredHeader(request, "x-kiln-peer-key"),
          "base64url"
        ).toString("utf8"),
        proof: requiredHeader(request, "x-kiln-proof"),
        requestedAt: Number(requiredHeader(request, "x-kiln-requested-at")),
        signature,
      }
    })
    const { grant } = credentials
    if (
      grant.transferId !== transferId ||
      grant.audience !== options.identity.fingerprint ||
      grant.expiresAt <= now ||
      grant.issuedAt > now + 5_000 ||
      grant.expiresAt - grant.issuedAt > MAX_GRANT_LIFETIME_MS
    ) {
      return yield* Effect.fail(new Error("Transfer grant scope is invalid"))
    }
    const source = options.sources.artifactRecord(transferId)
    if (!source) {
      return yield* Effect.fail(new Error("Transfer artifact is unavailable"))
    }
    const client = yield* options.state.findClientById(grant.issuer)
    if (
      !client ||
      !actionsForRole(client.role, client.actions).includes(
        fileTransferAction(source.rootId, "download")
      ) ||
      !verify(
        null,
        Buffer.from(credentials.encoded),
        client.publicKey,
        Buffer.from(credentials.signature, "base64url")
      )
    ) {
      return yield* Effect.fail(new Error("Transfer grant issuer is invalid"))
    }
    yield* Effect.try(() => {
      if (fingerprint(credentials.peerKey) !== grant.peer) {
        throw new Error("Peer key does not match the grant")
      }
      if (
        !Number.isSafeInteger(credentials.requestedAt) ||
        Math.abs(now - credentials.requestedAt) > PROOF_WINDOW_MS ||
        credentials.nonce.length < 16 ||
        credentials.nonce.length > 128
      ) {
        throw new Error("Peer proof freshness is invalid")
      }
      const valid = verify(
        null,
        Buffer.from(
          relayPeerTransferProofTranscript({
            audience: options.identity.fingerprint,
            method,
            nonce: credentials.nonce,
            range: request.headers.range ?? "",
            requestedAt: credentials.requestedAt,
            transferId,
          })
        ),
        createPublicKey(credentials.peerKey),
        Buffer.from(credentials.proof, "base64url")
      )
      if (!valid) throw new Error("Peer proof is invalid")
    })
    for (const [nonce, expiresAt] of nonces) {
      if (expiresAt <= now) nonces.delete(nonce)
    }
    const replayKey = `${grant.peer}:${credentials.nonce}`
    if (nonces.has(replayKey) || nonces.size >= MAX_REMEMBERED_NONCES) {
      return yield* Effect.fail(new Error("Peer proof was replayed"))
    }
    nonces.set(replayKey, now + PROOF_WINDOW_MS * 2)
    return { grant, rootId: source.rootId }
  })

  const audit = (
    grant: RelayPeerTransferGrant,
    bytes: number,
    completed: boolean
  ) =>
    options.state
      .appendAudit({
        clientId: grant.issuer,
        details: {
          bytes,
          outcome: completed ? "completed" : "aborted",
          peer: grant.peer,
          transferId: grant.transferId,
        },
        event: "peer.transfer.download",
        id: randomUUID(),
        occurredAt: Date.now(),
        requestId: grant.transferId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            reportRelayError(cause, { operation: "peer.transfer.audit" })
          })
        )
      )

  const serve = (
    request: IncomingMessage,
    response: ServerResponse,
    transferId: string
  ): Effect.Effect<TransferResult | void, unknown, Scope.Scope> =>
    Effect.gen(function* () {
      const method = request.method
      if (method !== "GET" && method !== "HEAD") {
        return yield* reject(405, "Method not allowed")
      }
      yield* Effect.annotateCurrentSpan("kiln.transfer.id", transferId)
      const { grant, rootId } = yield* authenticate(
        request,
        method,
        transferId
      ).pipe(
        Effect.catch((cause) => reject(401, "Transfer grant is invalid", cause))
      )
      yield* Effect.annotateCurrentSpan({
        "kiln.file_root.id": rootId,
        "kiln.transfer.peer": grant.peer,
      })
      yield* options.gate.admit("peer", grant.peer)
      const artifact = options.sources.artifact(
        transferId,
        yield* Clock.currentTimeMillis
      )
      if (!artifact) {
        return yield* reject(404, "Transfer artifact is unavailable")
      }
      // The grant names the artifact by its digest, so a repacked one under
      // the same ID can't be served in its place.
      if (artifact.sha256 !== grant.sha256 || artifact.size !== grant.size) {
        return yield* reject(409, "Transfer artifact changed")
      }
      const range = yield* Effect.try({
        try: () => parseByteRange(request.headers.range, artifact.size),
        catch: (cause) =>
          new TransferRejected({
            status: 416,
            reason: cause instanceof Error ? cause.message : "Invalid range",
          }),
      })
      response.writeHead(range ? 206 : 200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(
          range ? range.end - range.start + 1 : artifact.size
        ),
        "Content-Type": "application/gzip",
        ETag: `"${artifact.sha256}"`,
        "X-Content-Type-Options": "nosniff",
        ...(range
          ? {
              "Content-Range": `bytes ${range.start}-${range.end}/${artifact.size}`,
            }
          : {}),
      })
      if (method === "HEAD") {
        response.end()
        return
      }
      const sent = yield* sendBody(
        createReadStream(artifact.path, range ?? undefined),
        response
      )
      yield* audit(grant, sent.bytes, sent.completed)
      return { ...sent, direction: "sent" } satisfies TransferResult
    })

  return {
    handleRequest: async (request, response) => {
      const url = new URL(request.url ?? "/", "http://relay")
      const match = url.pathname.match(/^\/v1\/peer\/transfers\/([^/]+)$/u)
      if (!match) return false
      const transferId = Option.getOrUndefined(
        Option.liftThrowable(decodeURIComponent)(match[1] ?? "")
      )
      await runRelayRequest(
        serveTransfer({
          route: "peer.transfer",
          request,
          response,
          // The pulling Relay's span, so both halves share one trace.
          parent: traceParentSpan(url.searchParams.get("traceparent")),
          program:
            transferId === undefined
              ? reject(400, "Transfer path is invalid")
              : serve(request, response, transferId),
        })
      )
      return true
    },
  }
}
