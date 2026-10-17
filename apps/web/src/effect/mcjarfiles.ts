import { Effect, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import { readThroughCache } from "@/lib/cache"

const headers = {
  Accept: "application/json",
  "User-Agent": "kiln-hearth",
}

// An empty list is never cached: it would hide every version, and replace
// the last-known list an outage falls back to.
const VersionCatalogSchema = Schema.Struct({
  versions: Schema.NonEmptyArray(Schema.String),
})
const decodeCachedVersionCatalog =
  Schema.decodeUnknownSync(VersionCatalogSchema)

// The Startup page lists versions on every open, and mcjarfiles answers in
// 300-650 ms, so Hearth keeps the list as long as browsers do. A last-known
// list covers an mcjarfiles outage.
export const listMcJarVersionsEffect = Effect.fn("mcjarfiles.versions")(
  function* (type: string, variant: string) {
    const load = requestJson(
      `https://mcjarfiles.com/api/get-versions/${encodeURIComponent(type)}/${encodeURIComponent(variant)}`,
      Schema.Array(Schema.String)
    ).pipe(
      Effect.flatMap((listed) => {
        const [first, ...rest] = new Set(
          listed.map((version) => version.trim()).filter(Boolean)
        )
        return first === undefined
          ? Effect.fail(
              ExternalServiceError.make({
                message: "mcjarfiles listed no versions",
                service: "mcjarfiles",
              })
            )
          : Effect.succeed({ versions: [first, ...rest] as const })
      })
    )
    return yield* readThroughCache({
      decode: decodeCachedVersionCatalog,
      fallbackOnError: true,
      load,
      policy: {
        fallbackTtlMs: 7 * 24 * 60 * 60_000,
        key: `mcjarfiles:versions:${type}:${variant}`,
        name: "Minecraft versions",
        ttlMs: 30 * 60_000,
      },
    })
  }
)

function requestJson<TValue>(
  url: string,
  schema: Schema.Decoder<TValue>
): Effect.Effect<TValue, ExternalServiceError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new Error(`mcjarfiles returned HTTP ${response.status}`)
      }
      return Schema.decodeUnknownSync(schema)(await response.json())
    },
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "mcjarfiles returned an invalid response",
        service: "mcjarfiles",
      }),
  })
}
