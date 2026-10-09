import { Cause, Effect, Schedule, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/http"

import {
  kilnGitRepositoryApiUrl,
  isKilnNightlyVersion,
  kilnReleaseVersionCore,
} from "@workspace/contracts"

import { ExternalServiceError } from "@/effect/errors"
import { kilnGitRepository } from "@/lib/environment"
import { isKilnReleaseVersion } from "@/lib/release-version"

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "kiln-hearth",
  "X-GitHub-Api-Version": "2022-11-28",
}

const GitHubAssetSchema = Schema.Struct({
  browser_download_url: Schema.String,
  name: Schema.String,
})

const GitHubReleaseSchema = Schema.Struct({
  assets: Schema.Array(GitHubAssetSchema),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  draft: Schema.Boolean,
  html_url: Schema.String,
  name: Schema.NullOr(Schema.String),
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  tag_name: Schema.String,
})

const ReleaseComponentSchema = Schema.Struct({
  digest: Schema.String,
  image: Schema.String,
})

export const ReleaseManifestSchema = Schema.Struct({
  channel: Schema.Literals(["nightly", "stable"]),
  commit: Schema.String,
  compatibility: Schema.Struct({
    relayProtocol: Schema.Number,
  }),
  components: Schema.Struct({
    hearth: ReleaseComponentSchema,
    relay: ReleaseComponentSchema,
  }),
  imageVersion: Schema.optionalKey(Schema.String),
  publishedAt: Schema.String,
  schemaVersion: Schema.Literal(1),
  version: Schema.String,
})

export type KilnReleaseManifest = typeof ReleaseManifestSchema.Type
export type PublicKilnRelease = {
  aliases: ReadonlyArray<string>
  channel: "nightly" | "stable"
  manifestUrl: string
  name: string
  notes: string | null
  publishedAt: string | null
  tag: string
  url: string
  version: string
}

export type KilnReleasePage = {
  hasNextPage: boolean
  releases: Array<PublicKilnRelease>
}

/**
 * One page of GitHub's release feed, newest first. Only published releases
 * with an update manifest are kept. Stable releases get their image version
 * alias from `kilnStableReleaseAliasesEffect`, not here.
 */
export const fetchKilnReleasePageEffect = Effect.fn("github.releases.page")(
  function* (page: number, perPage: number) {
    const repositoryApi = kilnGitRepositoryApiUrl(
      kilnGitRepository(),
      "releases"
    )
    const { body, link } = yield* requestJsonResponse(
      `${repositoryApi}?per_page=${perPage}&page=${page}`,
      Schema.Array(GitHubReleaseSchema)
    )
    return {
      hasNextPage: /<[^>]+>;\s*rel="next"/u.test(link),
      releases: body.flatMap((release): Array<PublicKilnRelease> => {
        if (release.draft || !release.tag_name.startsWith("v")) return []
        const version = release.tag_name.slice(1)
        if (!isKilnReleaseVersion(version)) return []
        const name = release.name?.trim() || release.tag_name
        const manifest = release.assets.find(
          (asset) => asset.name === "release-manifest.json"
        )
        if (!manifest) return []
        return [
          {
            aliases: releaseVersionAliases(name, version),
            channel: release.prerelease ? "nightly" : "stable",
            manifestUrl: manifest.browser_download_url,
            name,
            notes: release.body?.trim() || null,
            publishedAt: release.published_at,
            tag: release.tag_name,
            url: release.html_url,
            version,
          },
        ]
      }),
    } satisfies KilnReleasePage
  }
)

/**
 * A stable image keeps the nightly version it was promoted from, named in its
 * manifest. The alias lets an installed stable build be found by that version.
 */
export const kilnStableReleaseAliasesEffect = Effect.fn(
  "github.releases.stableAliases"
)(function* (release: PublicKilnRelease) {
  const manifest = yield* requestJson(
    release.manifestUrl,
    ReleaseManifestSchema
  )
  const imageVersion = manifest.imageVersion
  if (
    imageVersion === undefined ||
    !isKilnReleaseVersion(imageVersion) ||
    kilnReleaseVersionCore(imageVersion) !==
      kilnReleaseVersionCore(release.version)
  ) {
    return release.aliases
  }
  return [...release.aliases, imageVersion]
})

export const kilnReleaseManifestEffect = Effect.fn("github.releases.manifest")(
  function* (tag: string) {
    const repositoryApi = kilnGitRepositoryApiUrl(
      kilnGitRepository(),
      "releases"
    )
    const release = yield* requestJson(
      `${repositoryApi}/tags/${encodeURIComponent(tag)}`,
      GitHubReleaseSchema
    )
    if (release.draft) {
      return yield* ExternalServiceError.make({
        message: "The selected Kiln release is still a draft",
        service: "GitHub Releases",
      })
    }
    const manifest = release.assets.find(
      (asset) => asset.name === "release-manifest.json"
    )
    if (!manifest) {
      return yield* ExternalServiceError.make({
        message: "The selected Kiln release has no update manifest",
        service: "GitHub Releases",
      })
    }
    return yield* requestJson(
      manifest.browser_download_url,
      ReleaseManifestSchema
    )
  }
)

function releaseVersionAliases(
  releaseName: string,
  version: string
): ReadonlyArray<string> {
  if (!isKilnNightlyVersion(version)) return []
  const match = /^v(\d+\.\d+\.\d+) Nightly #([1-9]\d*)$/u.exec(releaseName)
  if (!match || match[1] !== kilnReleaseVersionCore(version)) return []
  return [`${match[1]}-nightly.${match[2]}`]
}

// Network failures, timeouts, and GitHub's own 5xx errors are worth a quick
// retry. Rate limits (403, 429) aren't: retrying spends what's left of them.
const isRetryableRequest = (error: unknown) =>
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "TransportError" ||
      (error.reason._tag === "StatusCodeError" &&
        error.reason.response.status >= 500)))

function requestJson<S extends Schema.Constraint>(url: string, schema: S) {
  return Effect.map(requestJsonResponse(url, schema), ({ body }) => body)
}

function requestJsonResponse<S extends Schema.Constraint>(
  url: string,
  schema: S
) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // The timeout covers reading the body too: a response whose headers
    // arrive but whose body stalls would otherwise hold the feed lock.
    return yield* client.get(url, { headers }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        Effect.map(
          HttpClientResponse.schemaBodyJson(schema)(response),
          (body) => ({ body, link: response.headers["link"] ?? "" })
        )
      ),
      Effect.timeout("15 seconds"),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 2,
        while: isRetryableRequest,
      })
    )
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) =>
      ExternalServiceError.make({
        cause,
        message: HttpClientError.isHttpClientError(cause)
          ? cause.reason._tag === "StatusCodeError"
            ? `GitHub returned HTTP ${cause.reason.response.status}`
            : "Couldn’t reach GitHub"
          : Cause.isTimeoutError(cause)
            ? "GitHub took too long to respond"
            : "GitHub returned an invalid response",
        service: "GitHub Releases",
      })
    )
  )
}
