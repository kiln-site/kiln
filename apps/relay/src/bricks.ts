import { createHash, randomBytes } from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
import { get } from "node:https"
import { isIP } from "node:net"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { parseDocument } from "yaml"
import { Effect, Result } from "effect"
import {
  brickAnswers,
  brickAnswersProblem,
  brickCatalogDocumentSchema,
  brickGame,
  brickInputs,
  brickRecipeSchema,
  brickRecipeV1Schema,
  builtinTailscaleBrick,
  builtinTailscaleBrickSource,
  fillBrickTemplate,
  latestVelocityVersion,
  readBrickRecipe,
  relayCatalogSchema,
  databaseBrickProblem,
  databaseEngineRuntimes,
  databaseEngineRunsImage,
  databaseEngineSchema,
} from "@workspace/contracts"

import { BrickRecipeError } from "./effect/errors.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { promiseEffect, recoverPromise } from "./effect/promise.js"
import type { IncomingMessage } from "node:http"
import type {
  Brick,
  BrickCatalogDocument,
  BrickReadiness,
  BrickRecipe,
  BrickVariableValue,
  RelayCatalog,
  DatabaseEngine,
} from "@workspace/contracts"
import {
  BlockedRemoteAddressError,
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "./source-policy.js"

const MAX_DOCUMENT_BYTES = 1024 * 1024
const CACHE_TTL_MS = 5 * 60_000
const MAX_REDIRECTS = 5
const secureLookup = secureRemoteLookup

interface CachedCatalog {
  expiresAt: number
  value: RelayCatalog
}

export interface GameServerPort {
  name: string
  container: number
  protocol: "tcp" | "udp" | "both"
  host?: number
}

/**
 * What the Relay runs of a game server Brick, with the format's defaults
 * filled in. Everything past this module reads a recipe through it.
 */
export interface GameServerBrick {
  architectures: ReadonlyArray<"amd64" | "arm64"> | null
  command: ReadonlyArray<string>
  /** Whether its console completes a command it is asked about. */
  consoleCompletion: boolean
  entrypoint: ReadonlyArray<string> | null
  game: string
  /** Where its one volume is mounted. */
  mount: string
  /**
   * As containers are labelled and backups record it: `minecraft-backend`
   * for the `minecraft` type, `direct` otherwise. Decide by `type`.
   */
  networkMode: "direct" | "minecraft-backend"
  pids: number
  /** The primary port first. */
  ports: ReadonlyArray<GameServerPort>
  readiness: BrickReadiness | null
  stopCommands: ReadonlyArray<string> | null
  stopSignal: string | null
  supportsSrv: boolean
  /**
   * The type its Brick names, which unlocks what Kiln does for it.
   * `minecraft` sits behind the Relay's Minecraft entry point, which
   * publishes only its first port and checks readiness with a status ping.
   */
  type: string | null
  user: string | null
  workingDirectory: string | null
}

export interface ResolvedBrick {
  environment: Readonly<Record<string, string>>
  image: string
  /** The memory limit it starts with, like `2G`, when it names one. */
  memory: string | null
  recipe: BrickRecipe
  runtimeName: string
  server: GameServerBrick
  values: Readonly<Record<string, BrickVariableValue>>
}

export class BrickCatalog {
  readonly #catalogUrl: URL
  readonly #snapshotDirectory: string
  #cache: CachedCatalog | null = null

  constructor(catalogUrl: string, dataDirectory: string) {
    this.#catalogUrl = parseUrl(catalogUrl, "configured catalog")
    validateCatalogProtocol(this.#catalogUrl)
    this.#snapshotDirectory = brickSnapshotDirectory(dataDirectory)
  }

  async catalog(): Promise<RelayCatalog> {
    if (this.#cache && this.#cache.expiresAt > Date.now()) {
      return this.#cache.value
    }
    const document = parseCatalog(
      await readDocument(this.#catalogUrl, this.#catalogUrl)
    )
    const listed = await Promise.all(
      document.recipes.map(async (reference): Promise<Brick | null> => {
        const source = parseUrl(reference, this.#catalogUrl)
        // A kind this Relay can't run yet is left out, not an error that
        // hides the rest of the catalog.
        const recipe = await recoverPromise(
          () => this.#loadRecipe(source, true),
          (cause) => {
            if (
              cause instanceof BrickRecipeError &&
              cause.code === "unsupported_brick"
            ) {
              return null
            }
            throw cause
          }
        )
        return recipe && { ...recipe, source: source.href }
      })
    )
    const bricks = listed.filter((brick) => brick !== null)
    const ids = new Set<string>()
    for (const brick of bricks) {
      if (ids.has(brick.metadata.id)) {
        throw recipeError(
          "duplicate_brick_id",
          this.#catalogUrl.href,
          `Catalog contains duplicate Brick id ${brick.metadata.id}`
        )
      }
      ids.add(brick.metadata.id)
    }
    const value = relayCatalogSchema.parse({
      format: "kiln.catalog/v1",
      name: document.name,
      author: document.author,
      docs: document.docs,
      support: document.support,
      bricks,
    })
    this.#cache = { expiresAt: Date.now() + CACHE_TTL_MS, value }
    return value
  }

  async recipe(source: string, snapshotSha256?: string): Promise<BrickRecipe> {
    if (source === builtinTailscaleBrickSource) {
      const { source: _source, ...recipe } = builtinTailscaleBrick
      return recipe
    }
    if (snapshotSha256) {
      return readBrickSnapshot(this.#snapshotDirectory, snapshotSha256)
    }
    const url = parseUrl(source, "recipe source")
    if (url.protocol === "file:") {
      return this.#loadRecipe(url, true)
    }
    if (url.protocol !== "https:") {
      throw recipeError(
        "insecure_recipe_source",
        url.href,
        "Custom Brick recipes must use HTTPS"
      )
    }
    return this.#loadRecipe(url, false)
  }

  async saveSnapshot(recipe: BrickRecipe): Promise<string> {
    return saveBrickSnapshot(this.#snapshotDirectory, recipe)
  }

  async #loadRecipe(source: URL, fromCatalog: boolean): Promise<BrickRecipe> {
    if (!fromCatalog && source.protocol !== "https:") {
      throw recipeError(
        "insecure_recipe_source",
        source.href,
        "Custom Brick recipes must use HTTPS"
      )
    }
    const parsed = readBrickRecipe(
      parseYaml(await readDocument(source, this.#catalogUrl), source)
    )
    if (!parsed.success) {
      throw recipeError(
        "invalid_recipe",
        source.href,
        parsed.error.issues
          .slice(0, 4)
          .map(
            (issue) => `${issue.path.join(".") || "recipe"}: ${issue.message}`
          )
          .join("; ")
      )
    }
    const recipe = resolveRecipeIconSource(parsed.data, source, fromCatalog)
    runnableBrick(recipe, source.href)
    return recipe
  }
}

export function resolveRecipeIconSource(
  recipe: BrickRecipe,
  recipeSource: URL,
  fromCatalog: boolean
): BrickRecipe {
  const reference = recipe.metadata.icon
  if (!reference) return recipe
  const parsedSource = Result.try(() => new URL(reference, recipeSource))
  if (Result.isFailure(parsedSource)) return withoutRecipeIcon(recipe)
  const source = parsedSource.success
  if (
    source.protocol !== "https:" &&
    !(
      fromCatalog &&
      recipeSource.protocol === "file:" &&
      source.protocol === "file:"
    )
  ) {
    return withoutRecipeIcon(recipe)
  }
  return {
    ...recipe,
    metadata: { ...recipe.metadata, icon: source.href },
  }
}

function withoutRecipeIcon(recipe: BrickRecipe): BrickRecipe {
  const { icon: _icon, ...metadata } = recipe.metadata
  return { ...recipe, metadata }
}

export function brickSnapshotDirectory(dataDirectory: string): string {
  return join(dataDirectory, "brick-snapshots")
}

export async function saveBrickSnapshot(
  snapshotDirectory: string,
  recipe: BrickRecipe
): Promise<string> {
  const parsed = brickRecipeSchema.parse(recipe)
  runnableBrick(parsed, "snapshot")
  return writeBrickSnapshot(snapshotDirectory, JSON.stringify(parsed))
}

/**
 * Keeps a recipe as a backup recorded it, under the checksum it had there:
 * one recorded while recipes were `kiln.brick/v1` stays v1 on disk and is
 * converted each time it is read.
 */
export async function saveRecordedBrickSnapshot(
  snapshotDirectory: string,
  document: unknown
): Promise<string> {
  const v1 = brickRecipeV1Schema.safeParse(document)
  const recorded = v1.success ? v1.data : brickRecipeSchema.parse(document)
  // Refused now, not when the server it belongs to next starts.
  recordedBrickRecipe(recorded)
  return writeBrickSnapshot(snapshotDirectory, JSON.stringify(recorded))
}

async function writeBrickSnapshot(
  snapshotDirectory: string,
  content: string
): Promise<string> {
  const sha256 = createHash("sha256").update(content).digest("hex")
  await mkdir(snapshotDirectory, { mode: 0o700, recursive: true })
  const destination = brickSnapshotPath(snapshotDirectory, sha256)
  await Effect.runPromise(writeFileAtomic(destination, content, 0o600))
  return sha256
}

function recordedBrickRecipe(document: unknown): BrickRecipe {
  const read = readBrickRecipe(document)
  if (!read.success) {
    throw recipeError(
      "invalid_recipe",
      "snapshot",
      read.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "recipe"}: ${issue.message}`)
        .join("; ")
    )
  }
  runnableBrick(read.data, "snapshot")
  return read.data
}

export async function readBrickSnapshot(
  directory: string,
  sha256: string
): Promise<BrickRecipe> {
  return recordedBrickRecipe(await readRecordedBrickSnapshot(directory, sha256))
}

/**
 * A snapshot as it is on disk, which is what its checksum names: a backup
 * records this, so restoring it keeps the checksum the server was made
 * with.
 */
export async function readRecordedBrickSnapshot(
  directory: string,
  sha256: string
): Promise<unknown> {
  const path = brickSnapshotPath(directory, sha256)
  const content = await readFile(path, "utf8")
  const actual = createHash("sha256").update(content).digest("hex")
  if (actual !== sha256) throw new Error("Brick snapshot checksum is invalid")
  return JSON.parse(content) as unknown
}

function brickSnapshotPath(directory: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Brick snapshot checksum is invalid")
  }
  return join(directory, `${sha256}.json`)
}

/**
 * A recipe as the game server the Relay runs. Refuses, as
 * `unsupported_brick`, what the format describes and this Relay doesn't run
 * yet: other kinds, and parts only they use.
 */
export function gameServerBrick(
  recipe: BrickRecipe,
  source = recipe.metadata.id
): GameServerBrick {
  const unsupported = (reason: string) =>
    recipeError("unsupported_brick", source, reason)
  if (recipe.kind !== "game-server") {
    throw unsupported(`A ${recipe.kind} Brick isn't a game server`)
  }
  const deploy = recipe.deploy
  if (deploy?.type !== "image") {
    throw unsupported("A game server Brick runs from an image")
  }
  const [mount, ...otherVolumes] = deploy.volumes ?? []
  if (!mount || otherVolumes.length > 0) {
    throw unsupported("A game server Brick keeps exactly one volume")
  }
  if (!deploy.ports?.length) {
    throw unsupported("A game server Brick needs at least one port")
  }
  const ports = deploy.ports.map((port): GameServerPort => {
    if (typeof port.port !== "number") {
      throw unsupported(`Port ${port.name} must be a number for a game server`)
    }
    if (port.expose !== undefined && port.expose !== "public") {
      throw unsupported(`Port ${port.name} must be public for a game server`)
    }
    return {
      name: port.name,
      container: port.port,
      protocol: port.protocol ?? "tcp",
      ...(port.host === undefined ? {} : { host: port.host }),
    }
  })
  const ready = deploy.ready
  if (ready && !("log" in ready)) {
    throw unsupported("A game server is ready by its log, or its first port")
  }
  const server = recipe["game-server"]
  return {
    architectures: recipe.metadata.platforms ?? null,
    command: deploy.command ?? [],
    consoleCompletion: recipe.minecraft?.completion ?? false,
    entrypoint: deploy.entrypoint ?? null,
    game: brickGame(recipe),
    mount,
    networkMode: recipe.type === "minecraft" ? "minecraft-backend" : "direct",
    pids: deploy.pids ?? 512,
    ports,
    readiness: ready ? { logs: ready.log } : null,
    stopCommands: server?.stop ?? null,
    stopSignal: deploy.stopSignal ?? null,
    supportsSrv: server?.srv ?? false,
    type: recipe.type ?? null,
    user: deploy.user ?? null,
    workingDirectory: deploy.workingDirectory ?? null,
  }
}

/**
 * The answers a Brick is provisioned with: what was given, and what Kiln has
 * to look up for it. Looked up once, and then given to whatever provisions
 * later, so it installs the version the instance was made with.
 */
export async function brickProvisioningAnswers(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>
): Promise<Readonly<Record<string, BrickVariableValue>>> {
  if (
    recipe.minecraft?.latestVersion !== "velocity" ||
    Object.hasOwn(input, "version")
  ) {
    return input
  }
  const response = await fetch(
    "https://mcjarfiles.com/api/get-versions/proxies/velocity",
    {
      headers: { Accept: "application/json", "User-Agent": "kiln-relay" },
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (!response.ok)
    throw new Error(`Could not load Velocity versions: HTTP ${response.status}`)
  const versions: unknown = await response.json()
  if (
    !Array.isArray(versions) ||
    !versions.every((version) => typeof version === "string")
  ) {
    throw new Error("Velocity version catalog returned an invalid response")
  }
  const version = latestVelocityVersion(versions)
  if (!version)
    throw new Error("Velocity version catalog contains no supported versions")
  return { ...input, version }
}

export async function resolveBrickForProvisioning(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  source: string
): Promise<ResolvedBrick> {
  return resolveBrick(
    recipe,
    await brickProvisioningAnswers(recipe, input),
    source
  )
}

/**
 * A recipe as something this Relay runs, whatever kind it is. Refuses, as
 * `unsupported_brick`, a kind or a part it doesn't run yet.
 */
function runnableBrick(recipe: BrickRecipe, source: string): void {
  if (recipe.kind === "database") databaseBrick(recipe, source)
  else gameServerBrick(recipe, source)
}

/** What a database Brick says of the container a database runs in. */
export interface DatabaseBrick {
  command: ReadonlyArray<string>
  /** Where its data volume is mounted. */
  dataMount: string
  engine: DatabaseEngine
  /** The port it listens on. */
  internalPort: number
  /** The command that succeeds once it serves; its type's own without one. */
  ready: string | null
}

/**
 * A recipe as the database the Relay runs. A database is one of the types
 * Kiln has the login, dumps and viewer for, from an image, listening on its
 * first port and keeping its data in its first volume.
 */
export function databaseBrick(
  recipe: BrickRecipe,
  source = recipe.metadata.id
): DatabaseBrick {
  const unsupported = (reason: string) =>
    recipeError("unsupported_brick", source, reason)
  // What its type needs of it, which Hearth checks before offering it.
  const problem = databaseBrickProblem(recipe)
  if (problem) throw unsupported(problem)
  const engine = databaseEngineSchema.parse(recipe.type)
  const deploy = recipe.deploy
  // `databaseBrickProblem` refused anything else.
  if (deploy?.type !== "image") {
    throw unsupported("A database Brick runs from an image")
  }
  const port = deploy.ports?.[0]?.port
  const dataMount = deploy.volumes?.[0]
  if (typeof port !== "number" || dataMount === undefined) {
    throw unsupported("A database Brick names its port and its volume")
  }
  const ready = deploy.ready
  if (ready && !("command" in ready)) {
    throw unsupported("A database is ready by a command")
  }
  // What a game server takes from its Brick and a database doesn't yet.
  const unused = (
    [
      "entrypoint",
      "memory",
      "pids",
      "runtime",
      "stopSignal",
      "user",
      "workingDirectory",
    ] as const
  ).filter((field) => deploy[field] !== undefined)
  if (unused.length > 0) {
    throw unsupported(`A database Brick can't set ${unused.join(", ")} yet`)
  }
  return {
    command: deploy.command ?? [],
    dataMount,
    engine,
    internalPort: port,
    ready: ready?.command ?? null,
  }
}

/** A database Brick with its answers and what Kiln gives it filled in. */
export interface ResolvedDatabaseBrick extends DatabaseBrick {
  environment: Record<string, string>
  image: string
  recipe: BrickRecipe
  /** Every answer, with the secrets Kiln made. */
  values: Record<string, BrickVariableValue>
}

/**
 * A database Brick resolved for one database: its answers, and the name,
 * login and address Kiln gives it, which its templates take as
 * `database.*`.
 */
export function resolveDatabaseBrick(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  database: {
    host: string
    name: string
    password: string
    username: string
  },
  source = recipe.metadata.id
): ResolvedDatabaseBrick {
  const brick = databaseBrick(recipe, source)
  const deploy = recipe.deploy
  // `databaseBrick` refused anything else.
  if (deploy?.type !== "image") throw new Error("Not an image Brick")
  const supplied: Readonly<Record<string, string>> = {
    "database.host": database.host,
    "database.name": database.name,
    "database.password": database.password,
    "database.port": String(brick.internalPort),
    "database.username": database.username,
  }
  const { interpolate, values } = brickAnswered(recipe, input, source, supplied)
  // An answer is part of the image's name, so it is checked once filled in.
  const image = interpolate(deploy.image)
  if (!databaseEngineRunsImage(brick.engine, image)) {
    throw unsupportedImage(source, brick.engine)
  }
  return {
    ...brick,
    environment: Object.fromEntries(
      Object.entries(deploy.env ?? {}).map(([name, value]) => [
        name,
        interpolate(value),
      ])
    ),
    image,
    recipe,
    values,
  }
}

// Kiln's login, rotation, dumps and viewer for a type rely on its image.
function unsupportedImage(source: string, engine: DatabaseEngine) {
  return recipeError(
    "unsupported_brick",
    source,
    `A ${engine} database runs from the ${databaseEngineRuntimes[engine].image} image, at a tag`
  )
}

// A Brick's answers worked out, and its templates filled from them and from
// whatever Kiln supplies for its kind.
function brickAnswered(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  source: string,
  supplied: Readonly<Record<string, string>> = {}
): {
  interpolate: (template: string) => string
  values: Record<string, BrickVariableValue>
} {
  const inputs = brickInputs(recipe)
  const unknown = Object.keys(input).filter(
    (name) => !inputs.some((definition) => definition.key === name)
  )
  if (unknown.length > 0) {
    throw recipeError(
      "unknown_variable",
      source,
      `Unknown Brick variable${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    )
  }

  // What was given stands; the rest follows its rules, then its default.
  // A secret Kiln makes comes last: the format lets nothing follow one.
  const values = brickAnswers(inputs, input)
  for (const definition of inputs) {
    if (
      definition.type === "secret" &&
      definition.generate &&
      !Object.hasOwn(values, definition.key)
    ) {
      values[definition.key] = randomBytes(24).toString("base64url")
    }
  }
  const problem = brickAnswersProblem(inputs, values)
  if (problem) {
    throw recipeError(
      problem.code === "missing"
        ? "missing_variable"
        : problem.code === "invalid"
          ? "invalid_variable"
          : "unsupported_suggestion",
      source,
      problem.message
    )
  }

  const interpolate = (template: string): string =>
    fillBrickTemplate(template, (name) => {
      if (name === "brick.id") return recipe.metadata.id
      if (name === "brick.name") return recipe.metadata.name
      if (Object.hasOwn(supplied, name)) return supplied[name]
      if (!Object.hasOwn(values, name)) {
        throw recipeError(
          "missing_variable",
          source,
          `Template references unresolved variable ${name}`
        )
      }
      return String(values[name])
    })
  return { interpolate, values }
}

export function resolveBrick(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  source = recipe.metadata.id
): ResolvedBrick {
  const server = gameServerBrick(recipe, source)
  const deploy = recipe.deploy
  // `gameServerBrick` refused anything else.
  if (deploy?.type !== "image") throw new Error("Not an image Brick")
  const { interpolate, values } = brickAnswered(recipe, input, source)
  const memory = deploy.memory === undefined ? null : interpolate(deploy.memory)
  if (memory !== null && !/^\d+[bkmgt]$/iu.test(memory)) {
    throw recipeError(
      "invalid_resource",
      source,
      "Resolved memory must be a Docker memory value such as 2G"
    )
  }
  const image = interpolate(deploy.image)
  return {
    environment: Object.fromEntries(
      Object.entries(deploy.env ?? {}).map(([name, value]) => [
        name,
        interpolate(value),
      ])
    ),
    image,
    memory,
    recipe,
    runtimeName: deploy.runtime ? interpolate(deploy.runtime) : image,
    server,
    values,
  }
}

function parseCatalog(text: string): BrickCatalogDocument {
  const source = new URL("https://catalog.invalid/catalog.yml")
  const parsed = brickCatalogDocumentSchema.safeParse(parseYaml(text, source))
  if (!parsed.success) {
    throw recipeError(
      "invalid_catalog",
      "catalog",
      parsed.error.issues
        .slice(0, 4)
        .map(
          (issue) => `${issue.path.join(".") || "catalog"}: ${issue.message}`
        )
        .join("; ")
    )
  }
  return parsed.data
}

function parseYaml(text: string, source: URL): unknown {
  const document = parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw recipeError(
      "invalid_yaml",
      source.href,
      document.errors[0]?.message ?? "Invalid YAML"
    )
  }
  return document.toJS({ maxAliasCount: 20 })
}

async function readDocument(
  source: URL,
  configuredCatalog: URL
): Promise<string> {
  if (source.protocol === "file:") {
    validateLocalSource(source, configuredCatalog)
    const content = await readFile(fileURLToPath(source), "utf8")
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
      throw recipeError(
        "document_too_large",
        source.href,
        "Brick document exceeds 1 MiB"
      )
    }
    return content
  }
  if (source.protocol !== "https:") {
    throw recipeError(
      "insecure_recipe_source",
      source.href,
      "Brick documents must use HTTPS"
    )
  }
  return readHttpsDocument(source, source, 0)
}

function readHttpsDocument(
  source: URL,
  originalSource: URL,
  redirects: number
): Promise<string> {
  if (source.protocol !== "https:") {
    return Promise.reject(
      recipeError(
        "insecure_recipe_redirect",
        originalSource.href,
        "Brick source redirected away from HTTPS"
      )
    )
  }
  const literal = source.hostname.replace(/^\[|\]$/gu, "")
  if (isIP(literal) !== 0 && !isPublicRemoteAddress(literal)) {
    return Promise.reject(
      recipeError(
        "blocked_recipe_address",
        originalSource.href,
        "Brick source resolves to a private or reserved network address"
      )
    )
  }

  return new Promise((resolveDocument, rejectDocument) => {
    const request = get(
      source,
      {
        headers: { Accept: "application/yaml, text/yaml, application/json" },
        lookup: secureLookup,
        signal: AbortSignal.timeout(15_000),
      },
      (response) => {
        const status = response.statusCode ?? 0
        const redirectLocation = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && redirectLocation) {
          discardResponse(response)
          if (redirects >= MAX_REDIRECTS) {
            rejectDocument(
              recipeError(
                "too_many_recipe_redirects",
                originalSource.href,
                `Brick source exceeded ${MAX_REDIRECTS} redirects`
              )
            )
            return
          }
          const redirected = Result.try(() => new URL(redirectLocation, source))
          if (Result.isFailure(redirected)) {
            rejectDocument(
              recipeError(
                "invalid_recipe_redirect",
                originalSource.href,
                "Brick source returned an invalid redirect URL"
              )
            )
            return
          }
          Effect.runFork(
            promiseEffect(() =>
              readHttpsDocument(
                redirected.success,
                originalSource,
                redirects + 1
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
          discardResponse(response)
          rejectDocument(
            recipeError(
              "recipe_fetch_failed",
              originalSource.href,
              `Brick source returned HTTP ${status}`
            )
          )
          return
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0)
        if (declaredLength > MAX_DOCUMENT_BYTES) {
          discardResponse(response)
          rejectDocument(
            recipeError(
              "document_too_large",
              originalSource.href,
              "Brick document exceeds 1 MiB"
            )
          )
          return
        }
        Effect.runFork(
          promiseEffect(() =>
            readResponseDocument(response, originalSource.href)
          ).pipe(
            Effect.match({
              onFailure: rejectDocument,
              onSuccess: resolveDocument,
            })
          )
        )
      }
    )
    request.on("error", (cause: Error) => {
      rejectDocument(
        recipeError(
          cause instanceof BlockedRemoteAddressError
            ? "blocked_recipe_address"
            : "recipe_fetch_failed",
          originalSource.href,
          cause instanceof BlockedRemoteAddressError
            ? "Brick source resolves to a private or reserved network address"
            : cause.message
        )
      )
    })
  })
}

function discardResponse(response: IncomingMessage): void {
  response.on("error", () => undefined)
  response.resume()
}

function readResponseDocument(
  response: IncomingMessage,
  source: string
): Promise<string> {
  return new Promise((resolveDocument, rejectDocument) => {
    let content = ""
    let bytes = 0
    let settled = false

    const rejectResponse = (cause: Error): void => {
      if (settled) return
      settled = true
      response.destroy()
      rejectDocument(recipeError("recipe_fetch_failed", source, cause.message))
    }

    response.setEncoding("utf8")
    response.on("data", (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_DOCUMENT_BYTES) {
        settled = true
        response.destroy()
        rejectDocument(
          recipeError(
            "document_too_large",
            source,
            "Brick document exceeds 1 MiB"
          )
        )
        return
      }
      content += chunk
    })
    response.once("error", rejectResponse)
    response.once("aborted", () => {
      rejectResponse(
        new Error("Brick source response was interrupted before completion")
      )
    })
    response.once("close", () => {
      if (!response.complete) {
        rejectResponse(
          new Error("Brick source response closed before completion")
        )
      }
    })
    response.once("end", () => {
      if (settled) return
      settled = true
      resolveDocument(content)
    })
  })
}

function validateLocalSource(source: URL, configuredCatalog: URL): void {
  if (configuredCatalog.protocol !== "file:") {
    throw recipeError(
      "local_recipe_forbidden",
      source.href,
      "Local recipes require an explicitly configured file catalog"
    )
  }
  const root = dirname(resolve(fileURLToPath(configuredCatalog)))
  const candidate = resolve(fileURLToPath(source))
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw recipeError(
      "local_recipe_forbidden",
      source.href,
      "Local recipe must be inside the configured catalog directory"
    )
  }
}

function validateCatalogProtocol(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "file:") {
    throw recipeError(
      "insecure_catalog_source",
      url.href,
      "Brick catalog must use HTTPS or an explicitly configured file URL"
    )
  }
}

function parseUrl(value: string, base: string | URL): URL {
  return Result.try(
    () => new URL(value, base instanceof URL ? base : undefined)
  ).pipe(
    Result.getOrThrowWith(() =>
      recipeError("invalid_recipe_url", value, "Invalid recipe URL")
    )
  )
}

function recipeError(
  code: string,
  source: string,
  reason: string
): BrickRecipeError {
  return BrickRecipeError.make({ code, source, reason })
}
