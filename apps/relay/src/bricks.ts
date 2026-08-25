import { createHash } from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
import { get } from "node:https"
import { isIP } from "node:net"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { parseDocument } from "yaml"
import { Effect, Result } from "effect"
import {
  brickCatalogDocumentSchema,
  brickRecipeSchema,
  builtinTailscaleBrick,
  builtinTailscaleBrickSource,
  normalizeImportedBrickRecipeId,
  requiredMinecraftJavaVersion,
  relayCatalogSchema,
} from "@workspace/contracts"

import { BrickRecipeError } from "./effect/errors.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import { promiseEffect } from "./effect/promise.js"
import type { IncomingMessage } from "node:http"
import type {
  Brick,
  BrickCatalogDocument,
  BrickRecipe,
  BrickVariable,
  BrickVariableValue,
  RelayCatalog,
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

export interface ResolvedBrick {
  environment: Readonly<Record<string, string>>
  image: string
  memory: string
  memoryReservation: string
  recipe: BrickRecipe
  runtimeName: string
  values: Readonly<Record<string, BrickVariableValue>>
}

export interface ImportedBrickRecipe {
  idWasTruncated: boolean
  recipe: BrickRecipe
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
    const bricks = await Promise.all(
      document.recipes.map(async (reference) => {
        const source = parseUrl(reference, this.#catalogUrl)
        const imported = await this.#loadRecipe(source, true)
        return {
          ...imported.recipe,
          source: source.href,
        } satisfies Brick
      })
    )
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
    return (await this.importedRecipe(source, snapshotSha256)).recipe
  }

  async importedRecipe(
    source: string,
    snapshotSha256?: string
  ): Promise<ImportedBrickRecipe> {
    if (source === builtinTailscaleBrickSource) {
      const { source: _source, ...recipe } = builtinTailscaleBrick
      return { idWasTruncated: false, recipe }
    }
    if (snapshotSha256) {
      return {
        idWasTruncated: false,
        recipe: await readBrickSnapshot(
          this.#snapshotDirectory,
          snapshotSha256
        ),
      }
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

  async #loadRecipe(
    source: URL,
    fromCatalog: boolean
  ): Promise<ImportedBrickRecipe> {
    if (!fromCatalog && source.protocol !== "https:") {
      throw recipeError(
        "insecure_recipe_source",
        source.href,
        "Custom Brick recipes must use HTTPS"
      )
    }
    const normalized = normalizeImportedBrickRecipeId(
      parseYaml(await readDocument(source, this.#catalogUrl), source)
    )
    const parsed = brickRecipeSchema.safeParse(normalized.value)
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
    validateRecipeSemantics(recipe, source)
    return { idWasTruncated: normalized.idWasTruncated, recipe }
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
  validateRecipeSemantics(parsed, new URL("https://snapshot.invalid/brick.yml"))
  const content = JSON.stringify(parsed)
  const sha256 = createHash("sha256").update(content).digest("hex")
  await mkdir(snapshotDirectory, { mode: 0o700, recursive: true })
  const destination = brickSnapshotPath(snapshotDirectory, sha256)
  await Effect.runPromise(writeFileAtomic(destination, content, 0o600))
  return sha256
}

export async function readBrickSnapshot(
  directory: string,
  sha256: string
): Promise<BrickRecipe> {
  const path = brickSnapshotPath(directory, sha256)
  const content = await readFile(path, "utf8")
  const actual = createHash("sha256").update(content).digest("hex")
  if (actual !== sha256) throw new Error("Brick snapshot checksum is invalid")
  return brickRecipeSchema.parse(JSON.parse(content) as unknown)
}

function brickSnapshotPath(directory: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Brick snapshot checksum is invalid")
  }
  return join(directory, `${sha256}.json`)
}

export function resolveBrick(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  source = recipe.metadata.id
): ResolvedBrick {
  const unknown = Object.keys(input).filter(
    (name) => !Object.hasOwn(recipe.variables, name)
  )
  if (unknown.length > 0) {
    throw recipeError(
      "unknown_variable",
      source,
      `Unknown Brick variable${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    )
  }

  const values: Record<string, BrickVariableValue> = {}
  for (const [name, definition] of Object.entries(recipe.variables)) {
    const value = Object.hasOwn(input, name) ? input[name] : definition.default
    if (value === undefined) {
      if (definition.required) {
        throw recipeError(
          "missing_variable",
          source,
          `Brick variable ${name} is required`
        )
      }
      continue
    }
    validateVariable(name, definition, value, source)
    values[name] = value
  }
  applyRecommendedMinecraftJava(recipe, input, values, source)

  const interpolate = (template: string): string =>
    interpolateTemplate(template, recipe, values, source)
  const memory = interpolate(recipe.runtime.resources.memory)
  const memoryReservation = interpolate(
    recipe.runtime.resources.memoryReservation ??
      recipe.runtime.resources.memory
  )
  for (const [name, value] of [
    ["memory", memory],
    ["memoryReservation", memoryReservation],
  ] as const) {
    if (!/^\d+[bkmgt]$/iu.test(value)) {
      throw recipeError(
        "invalid_resource",
        source,
        `Resolved ${name} must be a Docker memory value such as 2G`
      )
    }
  }
  return {
    environment: Object.fromEntries(
      Object.entries(recipe.runtime.environment).map(([name, value]) => [
        name,
        interpolate(value),
      ])
    ),
    image: interpolate(recipe.runtime.image),
    memory,
    memoryReservation,
    recipe,
    runtimeName: interpolate(recipe.runtime.name),
    values,
  }
}

function applyRecommendedMinecraftJava(
  recipe: BrickRecipe,
  input: Readonly<Record<string, BrickVariableValue>>,
  values: Record<string, BrickVariableValue>,
  source: string
): void {
  if (Object.hasOwn(input, "java_version")) return
  const version = values.version
  const javaDefinition = recipe.variables.java_version
  const javaVersion =
    typeof version === "string"
      ? requiredMinecraftJavaVersion(recipe.metadata.id, version)
      : null
  if (!javaVersion || javaDefinition?.type !== "string") return
  const validation = Result.try(() =>
    validateVariable("java_version", javaDefinition, javaVersion, source)
  )
  if (Result.isFailure(validation)) {
    throw recipeError(
      "unsupported_java_version",
      source,
      `Minecraft ${version} requires Java ${javaVersion}, but this Brick does not publish that Ember`
    )
  }
  values.java_version = javaVersion
}

export function interpolateTemplate(
  template: string,
  recipe: BrickRecipe,
  values: Readonly<Record<string, BrickVariableValue>>,
  source = recipe.metadata.id
): string {
  const resolved = template.replace(
    /\{\{\s*(variables\.([a-z][a-z0-9_]{0,47})|brick\.(id|name))\s*\}\}/gu,
    (
      _match,
      _expression: string,
      variable: string | undefined,
      field: string | undefined
    ) => {
      if (variable) {
        if (!Object.hasOwn(values, variable)) {
          throw recipeError(
            "missing_variable",
            source,
            `Template references unresolved variable ${variable}`
          )
        }
        const value = values[variable]
        return String(value)
      }
      return field === "name" ? recipe.metadata.name : recipe.metadata.id
    }
  )
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw recipeError(
      "invalid_template",
      source,
      `Unsupported template expression in ${template}`
    )
  }
  return resolved
}

function validateVariable(
  name: string,
  definition: BrickVariable,
  value: BrickVariableValue,
  source: string
): void {
  if (typeof value !== definition.type) {
    throw recipeError(
      "invalid_variable",
      source,
      `${name} must be a ${definition.type}`
    )
  }
  if (
    definition.options &&
    !definition.options.some((option) => Object.is(option, value))
  ) {
    throw recipeError(
      "invalid_variable",
      source,
      `${name} must be one of the declared options`
    )
  }
  if (typeof value === "string") {
    const rules = definition.rules
    if (rules?.minLength !== undefined && value.length < rules.minLength) {
      throw recipeError(
        "invalid_variable",
        source,
        `${name} must contain at least ${rules.minLength} characters`
      )
    }
    if (rules?.maxLength !== undefined && value.length > rules.maxLength) {
      throw recipeError(
        "invalid_variable",
        source,
        `${name} must contain at most ${rules.maxLength} characters`
      )
    }
    if (rules?.pattern && !new RegExp(rules.pattern, "u").test(value)) {
      throw recipeError(
        "invalid_variable",
        source,
        `${name} does not match its recipe rule`
      )
    }
  }
  if (typeof value === "number") {
    if (definition.rules?.min !== undefined && value < definition.rules.min) {
      throw recipeError(
        "invalid_variable",
        source,
        `${name} must be at least ${definition.rules.min}`
      )
    }
    if (definition.rules?.max !== undefined && value > definition.rules.max) {
      throw recipeError(
        "invalid_variable",
        source,
        `${name} must be at most ${definition.rules.max}`
      )
    }
  }
}

function validateRecipeSemantics(recipe: BrickRecipe, source: URL): void {
  const primaryPorts = recipe.network.ports.filter(
    (port) => port.name === recipe.network.primaryPort
  )
  if (primaryPorts.length !== 1) {
    throw recipeError(
      "invalid_recipe",
      source.href,
      "network.primaryPort must name exactly one declared port"
    )
  }
  const portNames = new Set<string>()
  for (const port of recipe.network.ports) {
    if (portNames.has(port.name)) {
      throw recipeError(
        "invalid_recipe",
        source.href,
        `Duplicate network port name ${port.name}`
      )
    }
    portNames.add(port.name)
  }
  for (const [name, definition] of Object.entries(recipe.variables)) {
    if (
      definition.default !== undefined &&
      typeof definition.default !== definition.type
    ) {
      throw recipeError(
        "invalid_recipe",
        source.href,
        `${name}.default does not match its declared type`
      )
    }
    for (const option of definition.options ?? []) {
      if (typeof option !== definition.type) {
        throw recipeError(
          "invalid_recipe",
          source.href,
          `${name}.options does not match its declared type`
        )
      }
    }
    const pattern = definition.rules?.pattern
    if (pattern) {
      const compiledPattern = Result.try(() => new RegExp(pattern, "u"))
      if (Result.isFailure(compiledPattern)) {
        throw recipeError(
          "invalid_recipe",
          source.href,
          `${name}.rules.pattern is not a valid regular expression`
        )
      }
    }
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
  if (isIP(literal) !== 0 && !isPublicRecipeAddress(literal)) {
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

export function readResponseDocument(
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

export function isPublicRecipeAddress(address: string): boolean {
  return isPublicRemoteAddress(address)
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
      recipeError("invalid_recipe_url", value, `Invalid ${String(base)}`)
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
