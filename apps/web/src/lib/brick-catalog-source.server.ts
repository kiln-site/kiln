import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { get } from "node:https"
import { isIP } from "node:net"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  brickIdExceedsRecommendedLength,
  kilnDefaultEmberImage,
  brickCatalogDocumentSchema,
  brickRecipeSchema,
  readBrickRecipe,
  relayCatalogSchema,
  resolveKilnGitRepository,
  validateBrickIconSvg,
} from "@workspace/contracts"
import type {
  Brick,
  BrickDeploy,
  BrickRecipe,
  RelayCatalog,
} from "@workspace/contracts"
import { Effect, Result } from "effect"
import { parseDocument } from "yaml"

import { promiseEffect, recoverPromise } from "@/effect/promise"
import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "@/lib/public-remote-address.server"

const GITHUB_RAW_HOST = "raw.githubusercontent.com"
// The host an address names, however it is written: a name ending in a dot
// is the same host, and mustn't pass for another.
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/u, "")
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

function brickIconRetryDelay(failures: number): number {
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
  overlongBrickIds: Array<string>
}

interface ResolvedCatalogSource {
  catalogUrl: URL
  /** Where its recipes are, for one on GitHub. */
  tree: string | null
  revisionSha: string | null
  revisionUrl: string | null
  source: string
}

export async function loadBrickCatalogSource(
  input: string,
  options: {
    allowFile?: boolean
    timeoutMs?: number
    distributionRepository?: string
  } = {}
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
  const loadedBricks = await mapConcurrent(
    document.recipes,
    FETCH_CONCURRENCY,
    async (reference): Promise<Brick> => {
      const source = new URL(reference, resolvedSource.catalogUrl)
      if (!listedByItsRepository(source, resolvedSource.tree)) {
        throw new Error(
          `${source.href}: a recipe on GitHub is listed by a catalog of its own repository`
        )
      }
      const written = await readRecipe(
        source,
        resolvedSource.catalogUrl,
        options.allowFile === true,
        deadline
      )
      const parsedRecipe: BrickRecipe =
        options.distributionRepository && written.deploy?.type === "image"
          ? {
              ...written,
              deploy: {
                ...written.deploy,
                image: kilnDefaultEmberImage(
                  written.deploy.image,
                  options.distributionRepository
                ),
              },
            }
          : written
      const recipe = resolveRecipeIconSource(
        parsedRecipe,
        source,
        options.allowFile === true
      )
      return { ...recipe, source: source.href }
    }
  )
  // Every kind: whatever lists them for one kind asks for that kind.
  const bricks = loadedBricks
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
    overlongBrickIds: loadedBricks.flatMap((brick) =>
      brickIdExceedsRecommendedLength(brick.metadata.id)
        ? [brick.metadata.id]
        : []
    ),
  }
}

// A recipe as Hearth keeps it: read from its address, with any file it
// carries beside it made its own. A kiln.brick/v1 recipe is read as the v2
// Brick that runs the same.
async function readRecipe(
  source: URL,
  catalog: URL,
  allowFile: boolean,
  signal: AbortSignal
): Promise<BrickRecipe> {
  const read = readBrickRecipe(
    parseYaml(await readDocument(source, catalog, allowFile, signal), source)
  )
  if (!read.success) {
    throw new Error(
      `${source.href}: ${read.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "recipe"}: ${issue.message}`)
        .join("; ")}`
    )
  }
  return withCarriedFiles(read.data, source, catalog, allowFile, signal)
}

/**
 * Why an address can't be a custom Brick's link, or null when it can. A
 * link on GitHub names a branch or a tag, as a catalog's does: whatever is
 * installed from it is known by its repository and path, and is offered
 * that Brick's revisions from a catalog, so it mustn't be read at a commit
 * only a fork has.
 */
export function brickLinkProblem(input: string): string | null {
  const source = URL.canParse(input.trim()) ? new URL(input.trim()) : null
  if (source?.protocol !== "https:") {
    return "Custom Brick recipes must use HTTPS"
  }
  const github = githubCatalogUrl(source)
  return (
    github
      ? namesBranchOrTag(github.reference)
      : hostOf(source) !== GITHUB_RAW_HOST
  )
    ? null
    : "Link to the recipe on a branch or a tag of its repository, not at a commit"
}

/**
 * Where a custom Brick's link is read, and the address the Brick goes by.
 * One on GitHub, however it was written, goes by its raw address at its
 * branch or tag, which is what says whose it is and which Brick, and is
 * read at the commit that branch or tag is at: a Relay or Hearth fetching
 * the link as given would take whatever GitHub serves for it.
 */
export async function resolveBrickLink(
  input: string,
  signal = AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS)
): Promise<{ read: URL; source: string }> {
  const problem = brickLinkProblem(input)
  if (problem !== null) throw new Error(problem)
  const given = new URL(input.trim())
  const github = githubCatalogUrl(given)
  if (!github) return { read: given, source: given.href }
  const pin = (only?: "heads" | "tags") =>
    pinGithubCatalog(
      github.repository,
      github.reference,
      github.path,
      signal,
      only
    )
  const pinned = await pin(github.only)
  // The address it is kept by names the branch or tag alone. Where a
  // branch and a tag share a name, that reads the branch: a link that
  // says the tag would be kept as an address that reads something else.
  if (github.only && (await pin()).revisionSha !== pinned.revisionSha) {
    throw new Error(
      `${github.reference} is both a branch and a tag of its repository, at different commits. Link to the branch.`
    )
  }
  return {
    read: pinned.catalogUrl,
    source: `https://${GITHUB_RAW_HOST}${new URL(github.repository).pathname}/${github.reference}/${github.path}`,
  }
}

/**
 * A Brick read from a link of its own, in no catalog, with any file it
 * carries beside it. Hearth reads it for the kinds it turns into what runs,
 * an App and a group; a game server's is read by the Relay that would run
 * it.
 */
export async function loadBrickSource(input: string): Promise<Brick> {
  const signal = AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS)
  const { read, source } = await resolveBrickLink(input, signal)
  const recipe = resolveRecipeIconSource(
    await readRecipe(read, read, false, signal),
    read,
    false
  )
  return hydrateBrickIcon(
    { ...recipe, source },
    { signal: AbortSignal.timeout(ICON_HYDRATION_TIMEOUT_MS) }
  )
}

/**
 * Whether a catalog may list a recipe at this address. One on GitHub is in
 * the catalog's own repository, at the commit the catalog was read at
 * (`tree`): a link into another repository could name a commit only one of
 * its forks has, and pass a stranger's recipe off as that repository's.
 * Anywhere else, an address is served by whoever it names.
 */
function listedByItsRepository(recipe: URL, tree: string | null): boolean {
  return (
    hostOf(recipe) !== GITHUB_RAW_HOST ||
    (tree !== null && recipe.href.startsWith(tree))
  )
}

// Where a catalog on GitHub keeps its recipes: its repository at the
// commit it was read at. Null for a catalog kept anywhere else.
function githubTree(slug: string, sha: string): string {
  return `https://${GITHUB_RAW_HOST}/${slug}/${sha}/`
}

/**
 * Why a catalog Hearth stored can't be trusted to hold only its own
 * recipes, or null when it can. One stored before Kiln checked this may
 * name a commit only a fork has, or list another repository's recipe; it
 * is added again, which reads it under the rules above.
 */
export function storedCatalogProblem(stored: {
  revisionSha: string | null
  revisionUrl: string | null
  snapshot: RelayCatalog
  source: string
}): string | null {
  const again = "Add this catalog again: Kiln now checks whose its recipes are"
  const given = URL.canParse(stored.source)
    ? githubCatalogUrl(new URL(stored.source))
    : null
  // Read by name, as it has to be now. What an older Kiln read by anything
  // else may be a commit only a fork has.
  if (given && !namesBranchOrTag(given.reference)) return again
  // As `githubCatalogRevisionUrl` wrote it: the repository, then the commit.
  const read =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([a-f0-9]{40})\//u.exec(
      stored.revisionUrl ?? ""
    )
  const tree =
    read && read[2] === stored.revisionSha
      ? githubTree(read[1]!, read[2]!)
      : null
  return stored.snapshot.bricks.every(
    (brick) =>
      URL.canParse(brick.source) &&
      listedByItsRepository(new URL(brick.source), tree)
  )
    ? null
    : again
}

/**
 * Reads the file a Brick carries beside its recipe (`file`), for the Brick
 * itself and each member of a group, and makes it the Brick's own
 * `compose` or `dockerfile`: what Hearth keeps of a catalog is whole, and
 * everything after reads a file written in the Brick. The file is beside
 * the recipe, in its catalog: one elsewhere is refused.
 */
async function withCarriedFiles(
  recipe: BrickRecipe,
  recipeSource: URL,
  catalog: URL,
  allowFile: boolean,
  signal: AbortSignal
): Promise<BrickRecipe> {
  const carry = async <Deploy extends BrickDeploy | undefined>(
    deploy: Deploy
  ): Promise<Deploy> => {
    if (!deploy || deploy.type === "image" || deploy.file === undefined) {
      return deploy
    }
    const { file, ...rest } = deploy
    const reference = Result.getOrNull(
      Result.try(() => new URL(file, recipeSource))
    )
    // In its recipe's folder or below it, so a catalog read at a commit
    // reads its files at that commit too, and nothing of another
    // repository on the same host. An encoded separator could mean
    // another folder to whatever serves it.
    if (
      reference === null ||
      /%2f|%5c|\\/iu.test(file) ||
      !besideRecipe(reference, recipeSource)
    ) {
      throw new Error(`${file} isn't beside its recipe`)
    }
    const content = await readDocument(
      reference,
      catalog,
      allowFile,
      signal,
      { Accept: "text/plain, application/yaml, */*" },
      // A redirect is followed only to somewhere beside the recipe too.
      (target) => besideRecipe(target, recipeSource)
    )
    return { ...rest, [deploy.type]: content } as unknown as Deploy
  }
  const members = recipe.group?.members
  const carried = {
    ...recipe,
    ...(recipe.deploy ? { deploy: await carry(recipe.deploy) } : {}),
    ...(recipe.group && members
      ? {
          group: {
            ...recipe.group,
            members: Object.fromEntries(
              await Promise.all(
                Object.entries(members).map(async ([key, member]) => [
                  key,
                  "deploy" in member
                    ? { ...member, deploy: await carry(member.deploy) }
                    : member,
                ])
              )
            ),
          },
        }
      : {}),
  }
  if (carried.deploy === recipe.deploy && !members) return recipe
  // What it read must still make a Brick: a file too long, or empty, doesn't.
  const checked = brickRecipeSchema.safeParse(carried)
  if (!checked.success) {
    throw new Error(
      `${recipeSource.href}: ${checked.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "recipe"}: ${issue.message}`)
        .join("; ")}`
    )
  }
  return checked.data
}

// Whether a URL is in a recipe's folder or below it, on the same host.
function besideRecipe(target: URL, recipeSource: URL): boolean {
  return (
    target.protocol === recipeSource.protocol &&
    target.host === recipeSource.host &&
    target.pathname.startsWith(new URL(".", recipeSource).pathname)
  )
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
      tree: null,
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
        signal,
        github.only
      )),
      source: url.href,
    }
  }
  return {
    catalogUrl: url,
    revisionSha: null,
    revisionUrl: null,
    source: url.href,
    tree: null,
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

interface GithubLink {
  /** Whether it says which of a branch and a tag it means. */
  only?: "heads" | "tags"
  path: string
  reference: string
  repository: string
}

// What follows a repository in a link: the branch or tag it names, then a
// path in it. `refs/heads/<name>` and `refs/tags/<name>` say which outright.
// Any other ref, a pull request's among them, holds commits that may be a
// fork's: it is left as a reference no branch or tag is named by, which is
// refused. A name with a slash in it can't be told from a folder, so the
// first part of one is taken for the name.
function referenceAndPath(
  tail: ReadonlyArray<string>
): Omit<GithubLink, "repository"> | null {
  const [first, ...rest] = tail
  if (!first || rest.length === 0) return null
  if (first !== "refs") return { path: rest.join("/"), reference: first }
  const [kind, name, ...path] = rest
  return (kind === "heads" || kind === "tags") && name && path.length > 0
    ? { only: kind, path: path.join("/"), reference: name }
    : { path: rest.join("/"), reference: `refs/${kind ?? ""}` }
}

function githubCatalogUrl(url: URL): GithubLink | null {
  const [owner, repository, ...tail] = url.pathname.split("/").filter(Boolean)
  const hostname = hostOf(url)
  if (!owner || !repository) return null
  const named =
    hostname === GITHUB_RAW_HOST
      ? referenceAndPath(tail)
      : hostname === "github.com" && tail[0] === "blob"
        ? referenceAndPath(tail.slice(1))
        : null
  return (
    named && {
      ...named,
      repository: `https://github.com/${owner}/${repository.replace(/\.git$/u, "")}`,
    }
  )
}

const githubApiHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Kiln-Hearth",
  "X-GitHub-Api-Version": "2022-11-28",
}

async function githubApi(slug: string, path: string, signal: AbortSignal) {
  const url = new URL(`https://api.github.com/repos/${slug}/${path}`)
  return JSON.parse(
    await readHttpsDocument(url, url, 0, signal, githubApiHeaders)
  ) as unknown
}

const commitSha = (commit: unknown): string | null =>
  typeof commit === "object" &&
  commit !== null &&
  "sha" in commit &&
  typeof commit.sha === "string" &&
  /^[a-f0-9]{40}$/u.test(commit.sha)
    ? commit.sha
    : null

// A reference that can only be a branch or a tag, by its name: not a commit
// ID, whole or shortened, and nothing Git reads as a way to reach one
// (`main~1`, `<commit>^0`, `a..b`, `HEAD@{1}`). GitHub serves any commit of
// a repository's forks at the repository's own address, so a commit can't
// be told from the repository's own by how it is named. Nor a branch or a
// tag called `refs`: an address at one reads as a ref spelled out, so it
// would be kept as something else than was read.
const namesBranchOrTag = (reference: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(reference) &&
  reference !== "refs" &&
  !reference.includes("..") &&
  !/^[a-f0-9]{4,40}$/iu.test(reference)

/**
 * The commit a catalog on GitHub is read at, which is one its repository
 * published: its default branch, or a branch or tag of its own, looked up
 * by name. A commit ID is refused, as is any other way to name one: read at a commit
 * only a fork has, or at a pull request's, a stranger's recipe would be the
 * repository's. Kiln keeps the commit it read, so naming a branch still
 * leaves a catalog as it was when it was added.
 */
async function githubCatalogCommit(
  slug: string,
  reference: string,
  signal: AbortSignal,
  only?: "heads" | "tags"
): Promise<string> {
  if (!namesBranchOrTag(reference)) {
    throw new Error(
      `Name a branch or a tag of ${slug}, not a commit: Kiln keeps the commit it reads`
    )
  }
  const named = encodeURIComponent(reference)
  const lookup = (kind: "heads" | "tags") =>
    recoverPromise(
      () => githubApi(slug, `commits/${kind}/${named}`, signal),
      () => null
    )
  const commit = only
    ? await lookup(only)
    : reference === "HEAD"
      ? await githubApi(slug, "commits/HEAD", signal)
      : ((await lookup("heads")) ?? (await lookup("tags")))
  const sha = commitSha(commit)
  if (!sha) throw new Error(`${reference} isn't a branch or tag of ${slug}`)
  return sha
}

async function pinGithubCatalog(
  repository: string,
  reference: string,
  path: string,
  signal: AbortSignal,
  only?: "heads" | "tags"
): Promise<ResolvedCatalogSource> {
  const parsed = new URL(resolveKilnGitRepository(repository))
  const slug = parsed.pathname.slice(1)
  const sha = await githubCatalogCommit(slug, reference, signal, only)
  return {
    catalogUrl: new URL(
      `https://raw.githubusercontent.com/${slug}/${sha}/${path.replace(/^\/+/, "")}`
    ),
    revisionSha: sha,
    revisionUrl: githubCatalogRevisionUrl(repository, sha, path),
    source: repository,
    tree: githubTree(slug, sha),
  }
}

function githubCatalogRevisionUrl(
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
  headers?: Readonly<Record<string, string>>,
  /** Where a redirect may lead. Without it, anywhere public over HTTPS. */
  follows?: (target: URL) => boolean
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
  return readHttpsDocument(source, source, 0, signal, headers, follows)
}

function readHttpsDocument(
  source: URL,
  originalSource: URL,
  redirects: number,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>> | undefined = {
    Accept: "application/yaml, text/yaml, application/json",
  },
  follows?: (target: URL) => boolean
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
          if (follows && !follows(redirected.success)) {
            rejectDocument(
              new Error(`${originalSource.href} redirected somewhere else`)
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
                headers,
                follows
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
