import { get } from "node:https"
import { isIP } from "node:net"
import type { IncomingMessage } from "node:http"

import { Effect, Result } from "effect"

import { RelayRemoteFileError } from "./effect/errors.js"
import { promiseEffect } from "./effect/promise.js"
import { MAX_TRANSFER_BYTES } from "./files.js"
import {
  BlockedRemoteAddressError,
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "./source-policy.js"

const MAX_REDIRECTS = 5
const REMOTE_IDLE_TIMEOUT_MS = 30_000
const redirectStatuses = new Set([301, 302, 303, 307, 308])

export function withRemoteFileSource<TResult, TError, TRequirements>(
  source: string,
  use: (
    response: IncomingMessage
  ) => Effect.Effect<TResult, TError, TRequirements>
) {
  return Effect.acquireUseRelease(
    openRemoteFileSource(source),
    use,
    (response) =>
      Effect.sync(() => {
        response.destroy()
      })
  )
}

function openRemoteFileSource(source: string) {
  return Effect.tryPromise({
    try: () => {
      const url = new URL(source)
      return openHttpsResponse(url, url, 0)
    },
    catch: (cause) =>
      cause instanceof RelayRemoteFileError
        ? cause
        : remoteFileError(
            cause instanceof BlockedRemoteAddressError
              ? "blocked_remote_address"
              : "remote_download_failed",
            safeRemoteSource(source),
            cause instanceof BlockedRemoteAddressError
              ? "Remote file URL resolves to a private or reserved network address"
              : errorMessage(cause),
            cause
          ),
  })
}

function openHttpsResponse(
  source: URL,
  originalSource: URL,
  redirects: number
): Promise<IncomingMessage> {
  if (source.protocol !== "https:") {
    return Promise.reject(
      remoteFileError(
        "insecure_remote_source",
        safeRemoteSource(originalSource),
        "Remote file URLs and redirects must use HTTPS"
      )
    )
  }
  if (source.username || source.password) {
    return Promise.reject(
      remoteFileError(
        "remote_credentials_forbidden",
        safeRemoteSource(originalSource),
        "Remote file URLs cannot contain credentials"
      )
    )
  }
  const literal = source.hostname.replace(/^\[|\]$/gu, "")
  if (isIP(literal) !== 0 && !isPublicRemoteAddress(literal)) {
    return Promise.reject(
      remoteFileError(
        "blocked_remote_address",
        safeRemoteSource(originalSource),
        "Remote file URL resolves to a private or reserved network address"
      )
    )
  }

  return new Promise((resolveResponse, rejectResponse) => {
    const request = get(
      source,
      {
        headers: {
          Accept: "application/octet-stream, */*",
          "User-Agent": "kiln-relay/remote-file-download",
        },
        lookup: secureRemoteLookup,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const redirectLocation = response.headers.location
        if (redirectStatuses.has(status) && redirectLocation) {
          discardResponse(response)
          if (redirects >= MAX_REDIRECTS) {
            rejectResponse(
              remoteFileError(
                "too_many_redirects",
                safeRemoteSource(originalSource),
                `Remote file URL exceeded ${MAX_REDIRECTS} redirects`
              )
            )
            return
          }
          const redirected = Result.try(() => new URL(redirectLocation, source))
          if (Result.isFailure(redirected)) {
            rejectResponse(
              remoteFileError(
                "invalid_redirect",
                safeRemoteSource(originalSource),
                "Remote file URL returned an invalid redirect",
                redirected.failure
              )
            )
            return
          }
          Effect.runFork(
            promiseEffect(() =>
              openHttpsResponse(
                redirected.success,
                originalSource,
                redirects + 1
              )
            ).pipe(
              Effect.match({
                onFailure: rejectResponse,
                onSuccess: resolveResponse,
              })
            )
          )
          return
        }
        if (status < 200 || status >= 300) {
          discardResponse(response)
          rejectResponse(
            remoteFileError(
              "remote_http_error",
              safeRemoteSource(originalSource),
              `Remote file URL returned HTTP ${status}`
            )
          )
          return
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0)
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_TRANSFER_BYTES
        ) {
          discardResponse(response)
          rejectResponse(
            remoteFileError(
              "remote_file_too_large",
              safeRemoteSource(originalSource),
              "Remote file exceeds the 20 GiB transfer limit"
            )
          )
          return
        }
        resolveResponse(response)
      }
    )
    request.setTimeout(REMOTE_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error("Remote file request timed out"))
    })
    request.once("error", (cause) => rejectResponse(cause))
  })
}

function discardResponse(response: IncomingMessage): void {
  response.on("error", () => undefined)
  response.resume()
}

function remoteFileError(
  code: string,
  source: string,
  reason: string,
  cause?: unknown
) {
  return RelayRemoteFileError.make({
    code,
    source,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Remote file download failed"
}

function safeRemoteSource(source: string | URL): string {
  return Result.try(() => {
    const url = source instanceof URL ? new URL(source) : new URL(source)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href
  }).pipe(Result.getOrElse(() => "invalid remote file URL"))
}
