/**
 * Fetches part of an artifact from a source Relay. Each request is signed
 * with this Relay's identity key, and reaches the source over TLS trusted
 * through the CA Hearth pinned for it, or the system's for a public origin.
 */
import { randomBytes, sign } from "node:crypto"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { Effect, Option, Schema, Scope } from "effect"

import {
  relayPeerTransferPath,
  relayPeerTransferProofTranscript,
  type RelayPeerEndpoint,
} from "@workspace/contracts"

import type { RelayIdentity } from "../../effect/identity.js"
import { currentTraceparent } from "../../effect/runtime.js"

// A source that stops sending for this long is given up on for the attempt.
const IDLE_TIMEOUT_MS = 60_000

/**
 * Why a fetch failed. `retryable` failures, such as a dropped connection or
 * a busy source, are worth trying again; a refused grant or a missing
 * artifact isn't.
 */
export class PeerFetchError extends Schema.TaggedError<PeerFetchError>()(
  "PeerFetchError",
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export interface PeerRangeResponse {
  readonly body: IncomingMessage
  /** Where the body starts in the artifact. */
  readonly start: number
  /** The artifact's whole size, as the source reports it. */
  readonly total: number
}

/**
 * Opens the artifact from byte `offset` on. The response lives as long as
 * the scope; closing it ends the request.
 */
export const fetchArtifactRange = Effect.fn("RelayTransfer.fetchRange")(
  function* (input: {
    readonly audience: string
    readonly endpoint: RelayPeerEndpoint
    readonly grant: string
    readonly identity: RelayIdentity
    readonly offset: number
    readonly transferId: string
  }): Effect.fn.Return<PeerRangeResponse, PeerFetchError, Scope.Scope> {
    yield* Effect.annotateCurrentSpan({
      "kiln.transfer.id": input.transferId,
      "kiln.transfer.offset": input.offset,
      "url.full": input.endpoint.url,
    })
    const url = yield* Effect.try({
      try: () =>
        // Beneath the endpoint's own path, as Hearth's pass-through has.
        new URL(
          `${input.endpoint.url.replace(/\/+$/u, "")}${relayPeerTransferPath(input.transferId)}`
        ),
      catch: (cause) =>
        new PeerFetchError({
          reason: "The source Relay's address is invalid",
          retryable: false,
          cause,
        }),
    })
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return yield* new PeerFetchError({
        reason: "The source Relay's address is not HTTP",
        retryable: false,
      })
    }
    const traceparent = yield* currentTraceparent
    if (traceparent) url.searchParams.set("traceparent", traceparent)
    const range = `bytes=${input.offset}-`
    const nonce = randomBytes(24).toString("base64url")
    const requestedAt = Date.now()
    const proof = sign(
      null,
      Buffer.from(
        relayPeerTransferProofTranscript({
          audience: input.audience,
          method: "GET",
          nonce,
          range,
          requestedAt,
          transferId: input.transferId,
        })
      ),
      input.identity.privateKeyPem
    ).toString("base64url")
    const headers = {
      Authorization: `KilnPeer ${input.grant}`,
      Range: range,
      "X-Kiln-Nonce": nonce,
      "X-Kiln-Peer-Key": Buffer.from(input.identity.publicKeyPem).toString(
        "base64url"
      ),
      "X-Kiln-Proof": proof,
      "X-Kiln-Requested-At": String(requestedAt),
    }
    const body = yield* Effect.acquireRelease(
      Effect.callback<IncomingMessage, PeerFetchError>((resume) => {
        const options = {
          headers,
          method: "GET",
          timeout: IDLE_TIMEOUT_MS,
          ...(url.protocol === "https:" && input.endpoint.caCertificatePem
            ? { ca: input.endpoint.caCertificatePem }
            : {}),
        }
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(url, options, (response) => resume(Effect.succeed(response)))
        request.once("timeout", () =>
          request.destroy(new Error("The source Relay stopped responding"))
        )
        request.once("error", (cause) =>
          resume(
            Effect.fail(
              new PeerFetchError({
                reason: `Could not reach the source Relay at ${url.origin}: ${cause.message}`,
                retryable: true,
                cause,
              })
            )
          )
        )
        request.end()
        return Effect.sync(() => request.destroy())
      }),
      (response) => Effect.sync(() => response.destroy())
    )
    const status = body.statusCode ?? 0
    if (status !== 200 && status !== 206) {
      const reason = yield* failureReason(body)
      return yield* new PeerFetchError({
        reason: `The source Relay answered ${status}: ${reason}`,
        // A busy or briefly failing source may serve the next attempt.
        retryable: status === 429 || status >= 500,
        status,
      })
    }
    const parsed = parseContentRange(body, status)
    if (!parsed || parsed.start !== input.offset) {
      return yield* new PeerFetchError({
        reason: "The source Relay answered with the wrong part of the artifact",
        retryable: false,
        status,
      })
    }
    return { body, ...parsed }
  }
)

function parseContentRange(
  response: IncomingMessage,
  status: number
): { start: number; total: number } | null {
  if (status === 200) {
    const total = Number(response.headers["content-length"])
    return Number.isSafeInteger(total) ? { start: 0, total } : null
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(
    response.headers["content-range"] ?? ""
  )
  if (!match) return null
  const start = Number(match[1])
  const total = Number(match[3])
  return Number.isSafeInteger(start) && Number.isSafeInteger(total)
    ? { start, total }
    : null
}

const FailureBody = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String })
)

function failureReason(response: IncomingMessage) {
  return Effect.tryPromise(async () => {
    const chunks: Array<Buffer> = []
    let size = 0
    for await (const chunk of response) {
      size += (chunk as Buffer).byteLength
      if (size > 16_384) break
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  }).pipe(
    Effect.map((text) =>
      Option.match(Schema.decodeUnknownOption(FailureBody)(text), {
        onNone: () => "no reason given",
        onSome: (failure) => failure.error,
      })
    ),
    Effect.orElseSucceed(() => "no reason given")
  )
}
