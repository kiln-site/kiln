import { Effect } from "effect"
import { z } from "zod"

import { ExternalServiceError } from "@/effect/errors"
import type { ImageReference } from "@/lib/image-tags"

// Lists an image's tags, as anyone can pull it: without a credential, so a
// private image simply has none to offer.

const tagsPerPage = 1_000
// Tags come in alphabetical order, so stopping early loses the newest of them.
// These are the limits on a repository too big to read, not ones it should meet.
const pageLimit = 30
const timeoutMs = 20_000

const endpoints = {
  "docker.io": {
    api: "https://registry-1.docker.io",
    token: (repository: string) =>
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
  },
  "ghcr.io": {
    api: "https://ghcr.io",
    token: (repository: string) =>
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
  },
} satisfies Record<
  ImageReference["registry"],
  { api: string; token: (repository: string) => string }
>

const tokenSchema = z.object({ token: z.string() })
const tagsSchema = z.object({ tags: z.array(z.string()).nullable() })

const failed = (cause: unknown) =>
  ExternalServiceError.make({
    cause,
    message: "Could not list the image's versions",
    service: "Container registry",
  })

async function get(url: string, headers: HeadersInit, signal: AbortSignal) {
  const response = await fetch(url, { headers, redirect: "error", signal })
  if (!response.ok) throw new Error(`The registry answered ${response.status}`)
  return response
}

// The next page a registry names, only ever this repository's on this host.
function nextPage(link: string | null, first: URL): URL | null {
  const target = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/u)?.[1]
  if (!target) return null
  const next = new URL(target, first)
  return next.origin === first.origin && next.pathname === first.pathname
    ? next
    : null
}

export const listRegistryTagsEffect = Effect.fn("security.registryTags")(
  function* ({
    registry,
    repository,
  }: Pick<ImageReference, "registry" | "repository">) {
    const endpoint = endpoints[registry]
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const bounded = AbortSignal.any([
          signal,
          AbortSignal.timeout(timeoutMs),
        ])
        const { token } = tokenSchema.parse(
          await (await get(endpoint.token(repository), {}, bounded)).json()
        )
        const authorization = { Authorization: `Bearer ${token}` }
        const first = new URL(
          `${endpoint.api}/v2/${repository}/tags/list?n=${tagsPerPage}`
        )
        const tags: Array<string> = []
        let page: URL | null = first
        for (let read = 0; page && read < pageLimit; read++) {
          const response: Response = await get(
            page.toString(),
            authorization,
            bounded
          )
          const body = tagsSchema.parse(await response.json())
          tags.push(...(body.tags ?? []))
          page = nextPage(response.headers.get("link"), first)
        }
        return tags
      },
      catch: failed,
    })
  }
)
