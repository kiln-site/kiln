import { createSign } from "node:crypto"

import { Cause, Clock, Effect, Schedule, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"

import { ExternalServiceError } from "@/effect/errors"

// A GitHub App created and installed from Kiln, through GitHub's REST API.
// Kiln authenticates as the app with a JWT signed by its private key, and as
// one of its installations with a short-lived token exchanged for that JWT.

const githubApiUrl = "https://api.github.com"
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "kiln-hearth",
  "X-GitHub-Api-Version": "2022-11-28",
}

const GitHubAccountSchema = Schema.Struct({
  avatar_url: Schema.optionalKey(Schema.String),
  login: Schema.String,
  type: Schema.String,
})

const ManifestConversionSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  html_url: Schema.String,
  id: Schema.Number,
  name: Schema.String,
  owner: GitHubAccountSchema,
  pem: Schema.String,
  slug: Schema.String,
  webhook_secret: Schema.NullOr(Schema.String),
})

const InstallationSchema = Schema.Struct({
  account: GitHubAccountSchema,
  app_id: Schema.Number,
  id: Schema.Number,
  repository_selection: Schema.Literals(["all", "selected"]),
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const InstallationTokenSchema = Schema.Struct({
  expires_at: Schema.String,
  token: Schema.String,
})

const RepositorySchema = Schema.Struct({
  default_branch: Schema.String,
  full_name: Schema.String,
  html_url: Schema.String,
  id: Schema.Number,
  private: Schema.Boolean,
})

const RepositoryPageSchema = Schema.Struct({
  repositories: Schema.Array(RepositorySchema),
  total_count: Schema.Number,
})

const BranchSchema = Schema.Struct({
  commit: Schema.Struct({ sha: Schema.String }),
  name: Schema.String,
})

const BranchDetailSchema = Schema.Struct({
  commit: Schema.Struct({
    commit: Schema.Struct({ message: Schema.String }),
    sha: Schema.String,
  }),
  name: Schema.String,
})

const TreeSchema = Schema.Struct({
  sha: Schema.String,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha: Schema.String,
      size: Schema.optionalKey(Schema.Number),
      type: Schema.String,
    })
  ),
  truncated: Schema.Boolean,
})

const BlobSchema = Schema.Struct({
  content: Schema.String,
  encoding: Schema.String,
  size: Schema.Number,
})

const ErrorBodySchema = Schema.Struct({ message: Schema.String })
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBodySchema)

export type GitHubManifestConversion = typeof ManifestConversionSchema.Type
export type GitHubInstallation = typeof InstallationSchema.Type
export type GitHubRepository = typeof RepositorySchema.Type
export type GitHubTree = typeof TreeSchema.Type

export interface GitHubAppCredentials {
  appId: number
  privateKey: string
}

/** The manifest a person submits to GitHub to create Kiln's app. */
export function githubAppManifest(input: {
  hearthUrl: URL
  name: string
  /** GitHub only delivers webhooks to an address it can reach. */
  webhooks: boolean
}) {
  const url = (path: string) => new URL(path, input.hearthUrl).toString()
  return {
    callback_urls: [url("/api/github/setup")],
    default_events: input.webhooks ? ["push"] : [],
    // Contents write leaves room for saving edits back to the repository.
    default_permissions: { contents: "write", metadata: "read" },
    hook_attributes: {
      active: input.webhooks,
      url: url("/api/github/webhook"),
    },
    name: input.name,
    public: false,
    redirect_url: url("/api/github/manifest"),
    setup_on_update: true,
    setup_url: url("/api/github/setup"),
    url: input.hearthUrl.origin,
  }
}

export const convertGitHubManifestEffect = Effect.fn("github.app.convert")(
  function* (code: string) {
    return yield* githubRequest(
      "POST",
      `/app-manifests/${encodeURIComponent(code)}/conversions`,
      ManifestConversionSchema
    )
  }
)

export const getGitHubInstallationEffect = Effect.fn("github.app.installation")(
  function* (credentials: GitHubAppCredentials, installationId: number) {
    const jwt = yield* githubAppJwt(credentials)
    return yield* githubRequest(
      "GET",
      `/app/installations/${installationId}`,
      InstallationSchema,
      { token: jwt }
    )
  }
)

export const deleteGitHubInstallationEffect = Effect.fn("github.app.uninstall")(
  function* (credentials: GitHubAppCredentials, installationId: number) {
    const jwt = yield* githubAppJwt(credentials)
    yield* githubRequest(
      "DELETE",
      `/app/installations/${installationId}`,
      Schema.Unknown,
      { token: jwt }
    )
  }
)

// Installation tokens last an hour. Reuse one until five minutes before it
// expires, keyed by installation, so a sync doesn't mint one per request.
const installationTokens = new Map<
  number,
  { expiresAt: number; token: string }
>()

export const githubInstallationTokenEffect = Effect.fn(
  "github.app.installationToken"
)(function* (credentials: GitHubAppCredentials, installationId: number) {
  const now = yield* Clock.currentTimeMillis
  const cached = installationTokens.get(installationId)
  if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token
  const jwt = yield* githubAppJwt(credentials)
  const created = yield* githubRequest(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    InstallationTokenSchema,
    { token: jwt }
  )
  installationTokens.set(installationId, {
    expiresAt: Date.parse(created.expires_at),
    token: created.token,
  })
  return created.token
})

export function forgetGitHubInstallationToken(installationId: number) {
  installationTokens.delete(installationId)
}

/** Repositories the installation can read, up to 1,000. */
export const listGitHubRepositoriesEffect = Effect.fn(
  "github.repositories.list"
)(function* (token: string) {
  const repositories: Array<GitHubRepository> = []
  for (let page = 1; page <= 10; page += 1) {
    const result = yield* githubRequest(
      "GET",
      `/installation/repositories?per_page=100&page=${page}`,
      RepositoryPageSchema,
      { token }
    )
    repositories.push(...result.repositories)
    if (
      result.repositories.length < 100 ||
      repositories.length >= result.total_count
    )
      break
  }
  return repositories.sort((left, right) =>
    left.full_name.localeCompare(right.full_name)
  )
})

export const countGitHubRepositoriesEffect = Effect.fn(
  "github.repositories.count"
)(function* (token: string) {
  const page = yield* githubRequest(
    "GET",
    "/installation/repositories?per_page=1",
    RepositoryPageSchema,
    { token }
  )
  return page.total_count
})

export const getGitHubRepositoryEffect = Effect.fn("github.repository.get")(
  function* (token: string, repository: string) {
    return yield* githubRequest(
      "GET",
      `/repos/${pathSegments(repository)}`,
      RepositorySchema,
      { token }
    )
  }
)

export const listGitHubBranchesEffect = Effect.fn("github.branches.list")(
  function* (token: string, repository: string) {
    const branches = yield* githubRequest(
      "GET",
      `/repos/${pathSegments(repository)}/branches?per_page=100`,
      Schema.Array(BranchSchema),
      { token }
    )
    return branches.map((branch) => branch.name)
  }
)

export const getGitHubBranchHeadEffect = Effect.fn("github.branch.head")(
  function* (token: string, repository: string, branch: string) {
    const detail = yield* githubRequest(
      "GET",
      `/repos/${pathSegments(repository)}/branches/${pathSegments(branch)}`,
      BranchDetailSchema,
      { token }
    )
    return {
      message: detail.commit.commit.message,
      sha: detail.commit.sha,
    }
  }
)

export const getGitHubTreeEffect = Effect.fn("github.tree.get")(function* (
  token: string,
  repository: string,
  sha: string
) {
  return yield* githubRequest(
    "GET",
    `/repos/${pathSegments(repository)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    TreeSchema,
    { token }
  )
})

/** A file's bytes, by its blob SHA. */
export const getGitHubBlobEffect = Effect.fn("github.blob.get")(function* (
  token: string,
  repository: string,
  sha: string
) {
  const blob = yield* githubRequest(
    "GET",
    `/repos/${pathSegments(repository)}/git/blobs/${encodeURIComponent(sha)}`,
    BlobSchema,
    { token }
  )
  if (blob.encoding !== "base64") {
    return yield* ExternalServiceError.make({
      message: `GitHub returned a blob encoded as ${blob.encoding}`,
      service: "GitHub",
    })
  }
  return Buffer.from(blob.content.replace(/\s+/gu, ""), "base64")
})

// Branch names can hold slashes, which GitHub's paths take as they are.
function pathSegments(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}

/** An RS256 JWT that authenticates as the app for up to ten minutes. */
function githubAppJwt(credentials: GitHubAppCredentials) {
  return Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url")
    // Backdated a minute against clock drift, as GitHub recommends.
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      exp: now + 9 * 60,
      iat: now - 60,
      iss: String(credentials.appId),
    })}`
    return yield* Effect.try({
      try: () => {
        const signer = createSign("RSA-SHA256")
        signer.update(unsigned)
        return `${unsigned}.${signer.sign(credentials.privateKey, "base64url")}`
      },
      catch: (cause) =>
        ExternalServiceError.make({
          cause,
          message: "The GitHub App's private key is invalid",
          service: "GitHub",
        }),
    })
  })
}

// Network failures, timeouts, and GitHub's own 5xx errors are worth a quick
// retry. Rate limits (403, 429) aren't: retrying spends what's left of them.
const isRetryableRequest = (error: unknown) =>
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "TransportError" ||
      (error.reason._tag === "StatusCodeError" &&
        error.reason.response.status >= 500)))

function githubRequest<S extends Schema.Constraint>(
  method: "DELETE" | "GET" | "POST",
  path: string,
  schema: S,
  options: { token?: string } = {}
) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.make(method)(`${githubApiUrl}${path}`, {
      headers: options.token
        ? { ...githubHeaders, Authorization: `Bearer ${options.token}` }
        : githubHeaders,
    })
    const response = yield* client.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 2,
        while: isRetryableRequest,
      })
    )
    if (response.status >= 400) {
      const body = yield* response.json.pipe(
        Effect.option,
        Effect.map((value) =>
          value._tag === "Some" ? decodeErrorBody(value.value) : value
        )
      )
      return yield* ExternalServiceError.make({
        message: githubStatusMessage(
          response.status,
          body._tag === "Some" ? body.value.message : null
        ),
        service: "GitHub",
      })
    }
    if (response.status === 204) {
      return yield* Schema.decodeUnknownEffect(schema)(undefined)
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response)
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) =>
      cause instanceof ExternalServiceError
        ? cause
        : ExternalServiceError.make({
            cause,
            message: HttpClientError.isHttpClientError(cause)
              ? "Couldn’t reach GitHub"
              : Cause.isTimeoutError(cause)
                ? "GitHub took too long to respond"
                : "GitHub returned an invalid response",
            service: "GitHub",
          })
    )
  )
}

function githubStatusMessage(status: number, message: string | null) {
  if (status === 401) return "GitHub rejected Kiln's app credentials"
  if (status === 403 || status === 429)
    return message?.toLowerCase().includes("rate limit")
      ? "GitHub's rate limit was reached; try again in a few minutes"
      : "The GitHub App doesn't have access to this"
  if (status === 404)
    return "GitHub couldn't find it, or the app can't access it"
  return message ? `GitHub: ${message}` : `GitHub returned HTTP ${status}`
}
