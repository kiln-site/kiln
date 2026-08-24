import { createHash } from "node:crypto"
import { lookup } from "node:dns"
import { readFile } from "node:fs/promises"
import { get } from "node:https"
import { BlockList, isIP } from "node:net"
import type { LookupFunction } from "node:net"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  brickCatalogDocumentSchema,
  brickRecipeSchema,
  relayCatalogSchema,
  resolveKilnGitRepository,
  validateBrickIconSvg,
} from "@workspace/contracts"
import type { Brick, BrickRecipe, RelayCatalog } from "@workspace/contracts"
import { Effect, Result } from "effect"
import { parseDocument } from "yaml"

import { promiseEffect } from "@/effect/promise"

const MAX_DOCUMENT_BYTES = 1024 * 1024
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_CONCURRENCY = 8
const CATALOG_LOAD_TIMEOUT_MS = 60_000
const ICON_HYDRATION_TIMEOUT_MS = 60_000
const ICON_SUCCESS_TTL_MS = 5 * 60_000
const ICON_RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 15 * 60_000] as const

interface BrickIconCacheEntry {
  failures: number
  nextAttemptAt: number
  pending?: Promise<string | undefined>
  svg?: string
}

const brickIconCache = new Map<string, BrickIconCacheEntry>()

export function brickIconRetryDelay(failures: number): number {
  return ICON_RETRY_DELAYS_MS[
    Math.min(Math.max(0, failures), ICON_RETRY_DELAYS_MS.length - 1)
  ]!
}

export interface LoadedBrickCatalog {
  revisionSha: string | null
  revisionUrl: string | null
  snapshot: RelayCatalog
  snapshotSha256: string
  source: string
}

interface ResolvedCatalogSource {
  catalogUrl: URL
  revisionSha: string | null
  revisionUrl: string | null
  source: string
}

export async function loadBrickCatalogSource(
  input: string,
  options: { allowFile?: boolean; timeoutMs?: number } = {}
): Promise<LoadedBrickCatalog> {
  const deadline = AbortSignal.timeout(
    options.timeoutMs ?? CATALOG_LOAD_TIMEOUT_MS
  )
  const resolvedSource = await resolveCatalogSource(
    input,
    options.allowFile,
    deadline
  )
  const document = brickCatalogDocumentSchema.parse(
    parseYaml(
      await readDocument(
        resolvedSource.catalogUrl,
        resolvedSource.catalogUrl,
        options.allowFile === true,
        deadline
      ),
      resolvedSource.catalogUrl
    )
  )
  const bricks = await mapConcurrent(
    document.recipes,
    FETCH_CONCURRENCY,
    async (reference): Promise<Brick> => {
      const source = new URL(reference, resolvedSource.catalogUrl)
      const parsedRecipe = brickRecipeSchema.parse(
        parseYaml(
          await readDocument(
            source,
            resolvedSource.catalogUrl,
            options.allowFile === true,
            deadline
          ),
          source
        )
      )
      const recipe = resolveRecipeIconSource(
        parsedRecipe,
        source,
        options.allowFile === true
      )
      validateRecipeSemantics(recipe, source)
      return { ...recipe, source: source.href }
    }
  )
  const ids = new Set<string>()
  for (const brick of bricks) {
    if (ids.has(brick.metadata.id)) {
      throw new Error(
        `Catalog contains duplicate Brick id ${brick.metadata.id}`
      )
    }
    ids.add(brick.metadata.id)
  }
  const parsedSnapshot = relayCatalogSchema.parse({
    format: "kiln.catalog/v1",
    name: document.name,
    author: document.author,
    docs: document.docs,
    support: document.support,
    bricks,
  })
  const snapshot = await hydrateBrickCatalogIcons(parsedSnapshot, {
    allowFile: options.allowFile === true,
    catalogUrl: resolvedSource.catalogUrl,
    signal: AbortSignal.timeout(ICON_HYDRATION_TIMEOUT_MS),
  })
  const encoded = JSON.stringify(snapshot)
  if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Catalog snapshot exceeds 8 MiB")
  }
  return {
    ...resolvedSource,
    snapshot,
    snapshotSha256: createHash("sha256").update(encoded).digest("hex"),
  }
}

export async function hydrateBrickCatalogIcons(
  catalog: RelayCatalog,
  options: { allowFile?: boolean; catalogUrl?: URL; signal?: AbortSignal } = {}
): Promise<RelayCatalog> {
  const signal = options.signal ?? AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS)
  return {
    ...catalog,
    bricks: await mapConcurrent(
      catalog.bricks,
      FETCH_CONCURRENCY,
      async (brick) =>
        hydrateBrickIcon(brick, {
          allowFile: options.allowFile === true,
          catalogUrl: options.catalogUrl ?? new URL(brick.source),
          signal,
        })
    ),
  }
}

export async function hydrateBrickIcon(
  brick: Brick,
  options: {
    allowFile?: boolean
    catalogUrl?: URL
    signal?: AbortSignal
  } = {}
): Promise<Brick> {
  if (brick.iconSvg || !brick.metadata.icon) return brick
  const source = resolveBrickIconSource(
    brick.metadata.icon,
    new URL(brick.source),
    options.allowFile === true
  )
  if (!source) {
    const { icon: _icon, ...metadata } = brick.metadata
    return { ...brick, metadata }
  }
  const svg = await cachedBrickIcon(
    source,
    options.catalogUrl ?? new URL(brick.source),
    options.allowFile === true,
    options.signal ?? AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS)
  )
  return svg ? { ...brick, iconSvg: svg } : brick
}

function resolveRecipeIconSource(
  recipe: BrickRecipe,
  recipeSource: URL,
  allowFile: boolean
): BrickRecipe {
  const reference = recipe.metadata.icon
  if (!reference) return recipe
  const source = resolveBrickIconSource(reference, recipeSource, allowFile)
  if (!source) return withoutRecipeIcon(recipe)
  return {
    ...recipe,
    metadata: { ...recipe.metadata, icon: source.href },
  }
}

function resolveBrickIconSource(
  reference: string,
  recipeSource: URL,
  allowFile: boolean
): URL | null {
  const source = Result.try(() => new URL(reference, recipeSource))
  if (Result.isFailure(source)) return null
  if (
    source.success.protocol !== "https:" &&
    !(
      allowFile &&
      recipeSource.protocol === "file:" &&
      source.success.protocol === "file:"
    )
  ) {
    return null
  }
  return source.success
}

function withoutRecipeIcon(recipe: BrickRecipe): BrickRecipe {
  const { icon: _icon, ...metadata } = recipe.metadata
  return { ...recipe, metadata }
}

async function cachedBrickIcon(
  source: URL,
  catalog: URL,
  allowFile: boolean,
  signal: AbortSignal
): Promise<string | undefined> {
  const existing = brickIconCache.get(source.href)
  if (existing?.svg && existing.nextAttemptAt > Date.now()) return existing.svg
  if (existing?.pending) return existing.pending
  if (existing && existing.nextAttemptAt > Date.now()) return undefined

  const failures = existing?.failures ?? 0
  const pending = Effect.runPromise(
    promiseEffect(() =>
      readDocument(source, catalog, allowFile, signal, {
        Accept: "image/svg+xml",
      }).then(validateBrickIconSvg)
    ).pipe(
      Effect.match({
        onFailure: () => {
          brickIconCache.set(source.href, {
            failures: failures + 1,
            nextAttemptAt: Date.now() + brickIconRetryDelay(failures),
            ...(existing?.svg ? { svg: existing.svg } : {}),
          })
          return existing?.svg
        },
        onSuccess: (svg) => {
          brickIconCache.set(source.href, {
            failures: 0,
            nextAttemptAt: Date.now() + ICON_SUCCESS_TTL_MS,
            svg,
          })
          return svg
        },
      })
    )
  )
  brickIconCache.set(source.href, {
    failures,
    nextAttemptAt: 0,
    pending,
  })
  return pending
}

async function resolveCatalogSource(
  input: string,
  allowFile = false,
  signal: AbortSignal
): Promise<ResolvedCatalogSource> {
  const value = input.trim()
  if (!value) throw new Error("Enter a catalog URL or GitHub repository")

  const repository = githubRepositoryInput(value)
  if (repository) {
    return pinGithubCatalog(
      repository.repository,
      "HEAD",
      "catalog.yml",
      signal
    )
  }

  const parsedUrl = Result.try(() => new URL(value))
  if (Result.isFailure(parsedUrl)) {
    throw new Error("Enter an HTTPS catalog URL or GitHub owner/repository")
  }
  const url = parsedUrl.success
  if (url.protocol === "file:") {
    if (!allowFile) throw new Error("Personal catalogs must use HTTPS")
    return {
      catalogUrl: url,
      revisionSha: null,
      revisionUrl: null,
      source: url.href,
    }
  }
  if (url.protocol !== "https:") {
    throw new Error("Brick catalogs must use HTTPS")
  }
  const github = githubCatalogUrl(url)
  if (github) {
    return {
      ...(await pinGithubCatalog(
        github.repository,
        github.reference,
        github.path,
        signal
      )),
      source: url.href,
    }
  }
  return {
    catalogUrl: url,
    revisionSha: null,
    revisionUrl: null,
    source: url.href,
  }
}

function githubRepositoryInput(value: string): { repository: string } | null {
  if (value.includes("://")) {
    const parsedUrl = Result.try(() => new URL(value))
    if (Result.isFailure(parsedUrl)) return null
    const url = parsedUrl.success
    const segments = url.pathname.replace(/\/$/u, "").split("/").filter(Boolean)
    if (url.hostname.toLowerCase() !== "github.com" || segments.length !== 2) {
      return null
    }
  }
  const repository = Result.try(() => resolveKilnGitRepository(value))
  if (Result.isFailure(repository)) {
    return null
  }
  return { repository: repository.success }
}

function githubCatalogUrl(
  url: URL
): { path: string; reference: string; repository: string } | null {
  const segments = url.pathname.split("/").filter(Boolean)
  const hostname = url.hostname.toLowerCase()
  if (hostname === "raw.githubusercontent.com" && segments.length >= 4) {
    const [owner, repository, reference, ...path] = segments
    return owner && repository && reference && path.length > 0
      ? {
          path: path.join("/"),
          reference,
          repository: `https://github.com/${owner}/${repository}`,
        }
      : null
  }
  if (
    hostname === "github.com" &&
    segments[2] === "blob" &&
    segments.length >= 5
  ) {
    const [owner, repository, _blob, reference, ...path] = segments
    return owner && repository && reference && path.length > 0
      ? {
          path: path.join("/"),
          reference,
          repository: `https://github.com/${owner}/${repository.replace(/\.git$/u, "")}`,
        }
      : null
  }
  return null
}

async function pinGithubCatalog(
  repository: string,
  reference: string,
  path: string,
  signal: AbortSignal
): Promise<ResolvedCatalogSource> {
  const parsed = new URL(resolveKilnGitRepository(repository))
  const slug = parsed.pathname.slice(1)
  const commitUrl = new URL(
    `https://api.github.com/repos/${slug}/commits/${encodeURIComponent(reference)}`
  )
  const commit = JSON.parse(
    await readHttpsDocument(commitUrl, commitUrl, 0, signal, {
      Accept: "application/vnd.github+json",
      "User-Agent": "Kiln-Hearth",
      "X-GitHub-Api-Version": "2022-11-28",
    })
  ) as unknown
  const sha =
    typeof commit === "object" &&
    commit !== null &&
    "sha" in commit &&
    typeof commit.sha === "string" &&
    /^[a-f0-9]{40}$/u.test(commit.sha)
      ? commit.sha
      : null
  if (!sha) throw new Error("GitHub did not return a valid catalog commit")
  return {
    catalogUrl: new URL(
      `https://raw.githubusercontent.com/${slug}/${sha}/${path.replace(/^\/+/, "")}`
    ),
    revisionSha: sha,
    revisionUrl: githubCatalogRevisionUrl(repository, sha, path),
    source: repository,
  }
}

export function githubCatalogRevisionUrl(
  repository: string,
  sha: string,
  path: string
): string {
  return `${resolveKilnGitRepository(repository)}/blob/${sha}/${path.replace(/^\/+/, "")}`
}

function parseYaml(text: string, source: URL): unknown {
  const document = parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new Error(
      `${source.href}: ${document.errors[0]?.message ?? "Invalid YAML"}`
    )
  }
  return document.toJS({ maxAliasCount: 20 })
}

async function readDocument(
  source: URL,
  catalog: URL,
  allowFile: boolean,
  signal: AbortSignal,
  headers?: Readonly<Record<string, string>>
): Promise<string> {
  if (source.protocol === "file:") {
    if (!allowFile || catalog.protocol !== "file:") {
      throw new Error("Local recipes require a file-based default catalog")
    }
    const root = dirname(resolve(fileURLToPath(catalog)))
    const candidate = resolve(fileURLToPath(source))
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      throw new Error("Local recipes must remain inside the catalog directory")
    }
    const content = await readFile(candidate, "utf8")
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
      throw new Error("Brick document exceeds 1 MiB")
    }
    return content
  }
  if (source.protocol !== "https:") {
    throw new Error("Brick documents must use HTTPS")
  }
  return readHttpsDocument(source, source, 0, signal, headers)
}

function readHttpsDocument(
  source: URL,
  originalSource: URL,
  redirects: number,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>> | undefined = {
    Accept: "application/yaml, text/yaml, application/json",
  }
): Promise<string> {
  if (source.protocol !== "https:") {
    return Promise.reject(new Error("Brick source redirected away from HTTPS"))
  }
  const literal = source.hostname.replace(/^\[|\]$/gu, "")
  if (isIP(literal) !== 0 && !isPublicRemoteAddress(literal)) {
    return Promise.reject(
      new Error("Brick source resolves to a private or reserved address")
    )
  }
  return new Promise((resolveDocument, rejectDocument) => {
    const request = get(
      source,
      {
        headers,
        lookup: secureRemoteLookup,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume()
          if (redirects >= MAX_REDIRECTS) {
            rejectDocument(new Error("Brick source exceeded 5 redirects"))
            return
          }
          const redirected = Result.try(() => new URL(location, source))
          if (Result.isFailure(redirected)) {
            rejectDocument(
              new Error("Brick source returned an invalid redirect")
            )
            return
          }
          Effect.runFork(
            promiseEffect(() =>
              readHttpsDocument(
                redirected.success,
                originalSource,
                redirects + 1,
                signal,
                headers
              )
            ).pipe(
              Effect.match({
                onFailure: rejectDocument,
                onSuccess: resolveDocument,
              })
            )
          )
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          rejectDocument(
            new Error(`${originalSource.href} returned HTTP ${status}`)
          )
          return
        }
        const declared = Number(response.headers["content-length"] ?? 0)
        if (declared > MAX_DOCUMENT_BYTES) {
          response.resume()
          rejectDocument(new Error("Brick document exceeds 1 MiB"))
          return
        }
        let content = ""
        let bytes = 0
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > MAX_DOCUMENT_BYTES) {
            response.destroy(new Error("Brick document exceeds 1 MiB"))
            return
          }
          content += chunk
        })
        response.once("end", () => resolveDocument(content))
        response.once("error", rejectDocument)
      }
    )
    request.once("error", rejectDocument)
  })
}

function validateRecipeSemantics(recipe: BrickRecipe, source: URL): void {
  if (
    recipe.network.ports.filter(
      (port) => port.name === recipe.network.primaryPort
    ).length !== 1
  ) {
    throw new Error(
      `${source.href}: network.primaryPort must name exactly one declared port`
    )
  }
  const portNames = new Set<string>()
  for (const port of recipe.network.ports) {
    if (portNames.has(port.name)) {
      throw new Error(`${source.href}: duplicate network port ${port.name}`)
    }
    portNames.add(port.name)
  }
  for (const [name, definition] of Object.entries(recipe.variables)) {
    if (
      definition.default !== undefined &&
      typeof definition.default !== definition.type
    ) {
      throw new Error(`${source.href}: ${name}.default has the wrong type`)
    }
    if (
      definition.options?.some((option) => typeof option !== definition.type)
    ) {
      throw new Error(`${source.href}: ${name}.options has the wrong type`)
    }
    const pattern = definition.rules?.pattern
    if (pattern) {
      const compiled = Result.try(() => new RegExp(pattern, "u"))
      if (Result.isFailure(compiled)) {
        throw new Error(`${source.href}: ${name}.rules.pattern is invalid`)
      }
    }
  }
}

async function mapConcurrent<TInput, TResult>(
  input: ReadonlyArray<TInput>,
  concurrency: number,
  map: (value: TInput) => Promise<TResult>
): Promise<Array<TResult>> {
  const output = new Array<TResult>(input.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.length) }, async () => {
      while (next < input.length) {
        const index = next++
        const value = input[index]
        if (value !== undefined) output[index] = await map(value)
      }
    })
  )
  return output
}

const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6")
}

function isPublicRemoteAddress(address: string): boolean {
  const normalized = normalizeRemoteAddress(address)
  const family = isIP(normalized)
  return (
    family !== 0 &&
    !blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6")
  )
}

function normalizeRemoteAddress(value: string): string {
  const withoutZone = value.split("%", 1)[0] ?? value
  const mappedIpv4 = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mappedIpv4?.[1]) return mappedIpv4[1]
  if (isIP(withoutZone) !== 6) return withoutZone
  return Result.try(() => {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1)
    const mappedHex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/iu.exec(hostname)
    if (!mappedHex?.[1] || !mappedHex[2]) return withoutZone
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
  }).pipe(Result.getOrElse(() => withoutZone))
}

const secureRemoteLookup: LookupFunction = (hostname, options, callback) => {
  lookup(
    hostname,
    {
      all: true,
      family: options.family,
      hints: options.hints,
      order: options.order ?? "verbatim",
    },
    (error, addresses) => {
      if (error) {
        callback(error, "")
        return
      }
      const blocked = addresses.find(
        ({ address }) => !isPublicRemoteAddress(address)
      )
      if (blocked) {
        callback(new Error("Remote source resolved to a blocked address"), "")
        return
      }
      const selected = addresses[0]
      if (!selected) {
        callback(new Error("Remote source did not resolve"), "")
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, selected.address, selected.family)
    }
  )
}
