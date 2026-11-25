import { request } from "node:https"

import { webRouteHosts, type RelayInstanceWebRoute } from "@workspace/contracts"

const CHECK_TIMEOUT_MS = 5_000
// More than any of Traefik's own answers.
const MAX_ANSWER_BYTES = 256

export type WebRouteAnswer = "served" | "unrouted" | "down"

// Traefik's own answers: no router for the request, and a service it can't
// reach, has no server for, or that doesn't answer it in time.
const unrouted = "404 page not found"
const down = new Map([
  [502, "Bad Gateway"],
  [503, "no available server"],
  [504, "Gateway Timeout"],
])

/** Whether an answer is the instance's, or Traefik's for want of one. */
export function webRouteAnswer(status: number, body: string): WebRouteAnswer {
  const text = body.trim()
  if (status === 404 && text === unrouted) return "unrouted"
  return down.get(status) === text ? "down" : "served"
}

/**
 * What Traefik at `proxy` answers for each hostname, as a visitor's browser
 * would ask it, wherever the names point. Its certificate isn't checked: the
 * name has none here until it points here.
 */
export async function checkWebRoutes(
  proxy: string,
  routes: ReadonlyArray<RelayInstanceWebRoute>
): Promise<Array<{ hostname: string; state: WebRouteAnswer }>> {
  return Promise.all(
    routes
      .filter((route) => !route.redirect)
      .flatMap((route) =>
        webRouteHosts(route).served.map(async (hostname) => ({
          hostname,
          state: await ask(proxy, hostname, route.path ?? "/"),
        }))
      )
  )
}

function ask(
  proxy: string,
  hostname: string,
  path: string
): Promise<WebRouteAnswer> {
  return new Promise((resolve) => {
    const asked = request(
      {
        agent: false,
        headers: { Host: hostname },
        host: proxy,
        path,
        port: 443,
        rejectUnauthorized: false,
        servername: hostname,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      },
      (response) => {
        const chunks: Array<Buffer> = []
        let size = 0
        const done = () => {
          response.destroy()
          resolve(
            webRouteAnswer(
              response.statusCode ?? 0,
              Buffer.concat(chunks).toString("utf8")
            )
          )
        }
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk)
          size += chunk.length
          if (size > MAX_ANSWER_BYTES) done()
        })
        response.once("end", done)
        response.once("error", done)
      }
    )
    // Traefik itself isn't there to ask.
    asked.once("error", () => resolve("down"))
    asked.end()
  })
}
