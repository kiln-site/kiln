import { get } from "node:https"
import type { IncomingHttpHeaders } from "node:http"
import { isIP } from "node:net"

import { Effect, Result } from "effect"

import { promiseEffect } from "@/effect/promise"

import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "@/lib/public-remote-address.server"

// Fetches a small resource from a public HTTPS address someone gave Hearth,
// such as an image's URL or an app's site. It never reaches a private or
// reserved address, follows at most a few redirects (each checked again),
// and stops reading past `maxBytes`.

const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 10_000

export interface PublicHttpsResponse {
  readonly body: Buffer
  readonly contentType: string | undefined
  /** The address the body came from, after redirects. */
  readonly url: URL
}

export function fetchPublicHttps(
  input: string | URL,
  options: {
    readonly accept: string
    readonly maxBytes: number
    readonly signal?: AbortSignal
    /** Keep the first `maxBytes` of a longer body, as for a page's head. */
    readonly truncate?: boolean
    readonly timeoutMs?: number
  }
): Promise<PublicHttpsResponse> {
  const url = typeof input === "string" ? new URL(input) : input
  return request(url, options, 0)
}

function request(
  url: URL,
  options: {
    readonly accept: string
    readonly maxBytes: number
    readonly signal?: AbortSignal
    readonly truncate?: boolean
    readonly timeoutMs?: number
  },
  redirects: number
): Promise<PublicHttpsResponse> {
  if (url.protocol !== "https:") {
    return Promise.reject(new Error("Only HTTPS addresses can be fetched"))
  }
  if (url.username || url.password) {
    return Promise.reject(
      new Error("Addresses with credentials can't be fetched")
    )
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "")
  if (isIP(literal) !== 0 && !isPublicRemoteAddress(literal)) {
    return Promise.reject(
      new Error("That address is private or reserved, so Kiln won't fetch it")
    )
  }
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  ])
  return new Promise<PublicHttpsResponse>((resolve, reject) => {
    const call = get(
      url,
      {
        headers: {
          Accept: options.accept,
          "User-Agent": "Kiln (+https://kiln.site)",
        },
        lookup: secureRemoteLookup,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume()
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error(`${url.host} redirected too many times`))
            return
          }
          const next = Result.try(() => new URL(location, url))
          if (Result.isFailure(next)) {
            reject(new Error(`${url.host} returned an invalid redirect`))
            return
          }
          Effect.runFork(
            promiseEffect(() =>
              request(next.success, options, redirects + 1)
            ).pipe(Effect.match({ onFailure: reject, onSuccess: resolve }))
          )
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`${url.host} answered HTTP ${status}`))
          return
        }
        if (
          !options.truncate &&
          Number(response.headers["content-length"] ?? 0) > options.maxBytes
        ) {
          response.resume()
          reject(new Error(tooLarge(options.maxBytes)))
          return
        }
        const chunks: Array<Buffer> = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > options.maxBytes) {
            if (!options.truncate) {
              response.destroy(new Error(tooLarge(options.maxBytes)))
              return
            }
            chunks.push(chunk.subarray(0, chunk.byteLength - (size - options.maxBytes)))
            response.destroy()
            resolve({
              body: Buffer.concat(chunks),
              contentType: contentType(response.headers),
              url,
            })
            return
          }
          chunks.push(chunk)
        })
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            contentType: contentType(response.headers),
            url,
          })
        )
        response.once("error", reject)
      }
    )
    call.once("error", reject)
  })
}

function contentType(headers: IncomingHttpHeaders): string | undefined {
  return headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
}

function tooLarge(maxBytes: number): string {
  return `The response is larger than ${Math.round(maxBytes / 1024)} KiB`
}
