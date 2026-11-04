import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

import { Result } from "effect"

import {
  assertRelayAddress,
  relayDestinationLookup,
} from "@/server/relay-join.server"

const READ_TIMEOUT_MS = 5_000
// More than any answer a Relay gives; the other end may be anything.
const MAX_ANSWER_BYTES = 256

/**
 * What `url` answers from outside the Relay, or null when it doesn't: over
 * HTTPS, only with a publicly trusted certificate for its address. Follows no
 * redirects, since a route is proven by what answers at its own address.
 */
export function readRelayRoute(url: URL): Promise<string | null> {
  return new Promise((resolve) => {
    const guarded = Result.try(() =>
      assertRelayAddress(url.hostname.replace(/^\[|\]$/gu, ""))
    )
    if (Result.isFailure(guarded)) {
      resolve(null)
      return
    }
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        lookup: relayDestinationLookup,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy()
          resolve(null)
          return
        }
        const chunks: Array<Buffer> = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_ANSWER_BYTES) {
            response.destroy()
            resolve(null)
            return
          }
          chunks.push(chunk)
        })
        response.once("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8"))
        )
        response.once("error", () => resolve(null))
      }
    )
    request.once("error", () => resolve(null))
    request.end()
  })
}
