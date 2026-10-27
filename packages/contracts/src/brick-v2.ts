import { Result } from "effect"
import { z } from "zod"

// `kiln.brick/v2`: one JSON document that says what something is (`kind`),
// what someone fills in to install it (`inputs`), and how Kiln runs it
// (`deploy`). Databases add how to connect and back up. Fields are optional
// unless Kiln can't run the Brick without them, and parsing adds no defaults,
// so a document round-trips through an editor unchanged.
// See apps/bricks/docs/brick-v2.md.

export const BRICK_V2_FORMAT = "kiln.brick/v2"
export const BRICK_V2_CATALOG_FORMAT = "kiln.catalog/v2"
export const BRICK_V2_SCHEMA_URL = "https://kiln.site/bricks/schema.json"

export const brickV2Kinds = ["game-server", "app", "database"] as const
export const brickV2DeployTypes = [
  "image",
  "dockerfile",
  "compose",
  "static",
] as const
export const brickV2InputTypes = [
  "text",
  "number",
  "boolean",
  "select",
  "secret",
] as const
export const brickV2PortExposures = ["public", "http", "private"] as const

// Values every template can read besides the Brick's own inputs. Input keys
// can't contain a dot, so these never collide with one.
export const brickV2Builtins = {
  "kiln.brick": "The Brick's id",
  "kiln.name": "The name the instance was given",
  "kiln.host": "The hostname other instances reach it by",
} as const

const brickV2IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
const inputKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
const portNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u)
const serviceNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u)
const scalarSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
])
const absolutePathSchema = z
  .string()
  .max(512)
  .regex(/^\/[^\0]*$/u, "Use an absolute path")
const relativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== ".."),
    "Use a path inside the source, like Dockerfile or deploy/compose.yaml"
  )
const templateSchema = z.string().max(8_192)
const httpsUrlSchema = z
  .url()
  .max(2_048)
  .regex(/^https:\/\//iu, "Use an https:// link")

export const brickV2OptionSchema = z.union([
  z.string().min(1).max(128),
  z.number().finite(),
  z.strictObject({
    value: z.union([z.string().min(1).max(128), z.number().finite()]),
    label: z.string().min(1).max(80),
  }),
])

// A default that follows another input: the first rule whose input matches
// `matches` wins, otherwise `default` applies.
export const brickV2SuggestionSchema = z.strictObject({
  when: inputKeySchema,
  matches: z.string().min(1).max(512),
  value: scalarSchema,
})

export const brickV2InputSchema = z.strictObject({
  key: inputKeySchema,
  label: z.string().min(1).max(80),
  type: z.enum(brickV2InputTypes),
  help: z.string().min(1).max(280).optional(),
  placeholder: z.string().min(1).max(120).optional(),
  default: scalarSchema.optional(),
  // Required unless marked optional, so the common case says nothing.
  optional: z.boolean().optional(),
  // Folded under "Advanced" in the install form.
  advanced: z.boolean().optional(),
  options: z.array(brickV2OptionSchema).min(1).max(64).optional(),
  pattern: z.string().min(1).max(512).optional(),
  // The value's bounds for numbers, its length for text and secrets.
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  // Secrets only: Kiln makes a random one at install time.
  generate: z.boolean().optional(),
  suggest: z.array(brickV2SuggestionSchema).min(1).max(32).optional(),
})

export const brickV2PortSchema = z.strictObject({
  name: portNameSchema,
  port: z.number().int().min(1).max(65_535),
  // tcp unless set.
  protocol: z.enum(["tcp", "udp", "both"]).optional(),
  // public for game servers, http for apps, private for databases unless set.
  expose: z.enum(brickV2PortExposures).optional(),
  // The Compose service that listens on it.
  service: serviceNameSchema.optional(),
})

export const brickV2FileSchema = z.strictObject({
  path: absolutePathSchema,
  content: templateSchema.max(65_536),
  // Write it only when it doesn't exist, so later edits are kept.
  once: z.boolean().optional(),
})

// When it counts as started: a log line, a command that succeeds in the
// container, or an HTTP check on a port.
export const brickV2ReadySchema = z.union([
  z.strictObject({
    log: z.array(z.string().min(1).max(256)).min(1).max(8),
  }),
  z.strictObject({ command: templateSchema.min(1).max(2_048) }),
  z.strictObject({
    http: z.string().regex(/^\//u, "Start the path with /").max(512),
    port: portNameSchema.optional(),
  }),
])

const memorySchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?[MG]$/u, "Use a size like 512M or 2G")

// What every way of running in containers shares.
const runFields = {
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), templateSchema)
    .optional(),
  ports: z.array(brickV2PortSchema).max(16).optional(),
  ready: brickV2ReadySchema.optional(),
  // A starting memory limit. Hearth's own limit wins.
  memory: memorySchema.optional(),
  // The address it gets under the Relay's domain.
  hostname: templateSchema.min(1).max(256).optional(),
  // Console commands that stop it on purpose, so Kiln doesn't restart it.
  stop: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
}

// What a single container adds.
const containerFields = {
  ...runFields,
  command: z.array(templateSchema.max(2_048)).max(64).optional(),
  user: z
    .string()
    .regex(/^[0-9]+(?::[0-9]+)?$/u)
    .optional(),
  // Folders kept across restarts. The first is the one Files opens.
  volumes: z.array(absolutePathSchema).max(16).optional(),
  files: z.array(brickV2FileSchema).max(16).optional(),
}

export const brickV2DeploySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    image: templateSchema.min(1).max(512),
    ...containerFields,
  }),
  // Builds `dockerfile` as written, or the file at `path` in the source
  // chosen at install time.
  z.strictObject({
    type: z.literal("dockerfile"),
    dockerfile: z.string().min(1).max(200_000).optional(),
    path: relativePathSchema.optional(),
    ...containerFields,
  }),
  // Runs `compose` as written, or the file at `path` in the source chosen at
  // install time. `env` becomes the project's .env.
  z.strictObject({
    type: z.literal("compose"),
    compose: z.string().min(1).max(400_000).optional(),
    path: relativePathSchema.optional(),
    // The service whose console and logs Hearth opens first.
    service: serviceNameSchema.optional(),
    ...runFields,
  }),
  // Served by the Relay's shared web server from the source chosen at install
  // time. The build runs once per deploy, skipped when its command is empty.
  z.strictObject({
    type: z.literal("static"),
    root: z.string().min(1).max(1_024).optional(),
    build: z
      .strictObject({
        image: templateSchema.min(1).max(512),
        command: templateSchema.max(4_000),
      })
      .optional(),
    spa: z.boolean().optional(),
  }),
])

export const brickV2DatabaseSchema = z.strictObject({
  // The port clients connect to.
  port: portNameSchema,
  connection: templateSchema.min(1).max(1_024),
  // One of Hearth's own viewers. Hearth opens it for official Bricks only.
  viewer: z.enum(["mysql", "postgres"]).optional(),
  // Run in the container: backup writes a dump to stdout, restore reads one
  // from stdin. Without them, backups snapshot the volume.
  backup: templateSchema.min(1).max(2_048).optional(),
  restore: templateSchema.min(1).max(2_048).optional(),
})

export const brickV2LinksSchema = z.strictObject({
  homepage: httpsUrlSchema.optional(),
  source: httpsUrlSchema.optional(),
  docs: httpsUrlSchema.optional(),
  support: httpsUrlSchema.optional(),
})

const brickV2ShapeSchema = z.strictObject({
  $schema: z.string().max(2_048).optional(),
  format: z.literal(BRICK_V2_FORMAT),
  id: brickV2IdSchema,
  name: z.string().min(1).max(80),
  kind: z.enum(brickV2Kinds),
  summary: z.string().min(1).max(280),
  author: z.string().min(1).max(80),
  // Game servers: the game it runs, like Minecraft.
  game: z.string().min(1).max(80).optional(),
  icon: z.string().min(1).max(2_048).optional(),
  color: z
    .string()
    .regex(/^#[\da-f]{6}$/iu, "Use a #rrggbb color")
    .optional(),
  tags: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u))
    .max(12)
    .optional(),
  links: brickV2LinksSchema.optional(),
  platforms: z
    .array(z.enum(["amd64", "arm64"]))
    .min(1)
    .optional(),
  inputs: z.array(brickV2InputSchema).max(48).optional(),
  deploy: brickV2DeploySchema,
  database: brickV2DatabaseSchema.optional(),
})

export const brickV2Schema = brickV2ShapeSchema.superRefine(checkBrickV2)

export type BrickV2 = z.infer<typeof brickV2ShapeSchema>
export type BrickV2Kind = BrickV2["kind"]
export type BrickV2Input = z.infer<typeof brickV2InputSchema>
export type BrickV2InputType = BrickV2Input["type"]
export type BrickV2Option = z.infer<typeof brickV2OptionSchema>
export type BrickV2Suggestion = z.infer<typeof brickV2SuggestionSchema>
export type BrickV2Deploy = z.infer<typeof brickV2DeploySchema>
export type BrickV2DeployType = BrickV2Deploy["type"]
export type BrickV2Port = z.infer<typeof brickV2PortSchema>
export type BrickV2File = z.infer<typeof brickV2FileSchema>
export type BrickV2Ready = z.infer<typeof brickV2ReadySchema>
export type BrickV2Database = z.infer<typeof brickV2DatabaseSchema>
export type BrickV2Links = z.infer<typeof brickV2LinksSchema>
export type BrickV2Value = z.infer<typeof scalarSchema>
export type BrickV2PortExposure = (typeof brickV2PortExposures)[number]
// The deploy types that run in containers, with env, ports, and the rest.
export type BrickV2RunDeploy = Exclude<BrickV2Deploy, { type: "static" }>
// The deploy types that run one container, with volumes and files.
export type BrickV2ContainerDeploy = Extract<
  BrickV2Deploy,
  { type: "image" | "dockerfile" }
>

export const brickV2CatalogSchema = z.strictObject({
  $schema: z.string().max(2_048).optional(),
  format: z.literal(BRICK_V2_CATALOG_FORMAT),
  name: z.string().min(1).max(80),
  author: z.string().min(1).max(80),
  summary: z.string().min(1).max(280).optional(),
  links: brickV2LinksSchema.optional(),
  // Paths relative to the catalog, or https:// links.
  bricks: z.array(z.string().min(1).max(2_048)).min(1).max(256),
})

export type BrickV2Catalog = z.infer<typeof brickV2CatalogSchema>

// The format as JSON Schema, for editors that complete and check a Brick
// naming it in `$schema`. Cross-field rules, like templates naming a declared
// input, aren't expressible there; Kiln checks those.
export function brickV2JsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(brickV2ShapeSchema, { io: "input" }),
    $id: BRICK_V2_SCHEMA_URL,
    title: "Kiln Brick (kiln.brick/v2)",
  }
}

const TEMPLATE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/gu

// The names a template reads, in order, including ones that don't exist.
export function brickV2TemplateReferences(template: string): Array<string> {
  return Array.from(template.matchAll(TEMPLATE_PATTERN), (match) => match[1]!)
}

// Fills in a template. Literal replacement only: no expressions, escaping,
// or shell. Unknown names are left as written.
export function renderBrickV2Template(
  template: string,
  values: Readonly<Record<string, BrickV2Value | undefined>>
): string {
  return template.replace(TEMPLATE_PATTERN, (written, name: string) => {
    const value = values[name]
    return value === undefined ? written : String(value)
  })
}

export function brickV2OptionValue(option: BrickV2Option): string | number {
  return typeof option === "object" ? option.value : option
}

export function brickV2OptionLabel(option: BrickV2Option): string {
  return typeof option === "object" ? option.label : String(option)
}

// An input's or suggestion's pattern as a RegExp, or null when it isn't one.
export function brickV2Pattern(pattern: string): RegExp | null {
  return Result.getOrElse(
    Result.try(() => new RegExp(pattern, "u")),
    () => null
  )
}

// The default an input starts with given the other inputs' values: the first
// matching suggestion, then its own default.
export function brickV2InputDefault(
  input: BrickV2Input,
  values: Readonly<Record<string, BrickV2Value | undefined>>
): BrickV2Value | undefined {
  for (const rule of input.suggest ?? []) {
    const value = values[rule.when]
    if (
      value !== undefined &&
      brickV2Pattern(rule.matches)?.test(String(value))
    ) {
      return rule.value
    }
  }
  return input.default
}

// Whether installing it asks for a Git repository or an upload.
export function brickV2NeedsSource(deploy: BrickV2Deploy): boolean {
  if (deploy.type === "static") return true
  if (deploy.type === "dockerfile") return deploy.dockerfile === undefined
  if (deploy.type === "compose") return deploy.compose === undefined
  return false
}

export function brickV2PortExposure(
  kind: BrickV2Kind,
  port: BrickV2Port
): BrickV2PortExposure {
  if (port.expose) return port.expose
  if (kind === "game-server") return "public"
  if (kind === "database") return "private"
  return "http"
}

// Every template in the Brick, each with where it's written.
export function brickV2Templates(
  brick: BrickV2
): Array<{ path: Array<string | number>; template: string }> {
  const templates: Array<{ path: Array<string | number>; template: string }> =
    []
  const add = (path: Array<string | number>, template: string | undefined) => {
    if (template !== undefined) templates.push({ path, template })
  }
  const deploy = brick.deploy
  if (deploy.type === "image") add(["deploy", "image"], deploy.image)
  if (deploy.type === "dockerfile") {
    add(["deploy", "dockerfile"], deploy.dockerfile)
    add(["deploy", "path"], deploy.path)
  }
  if (deploy.type === "compose") {
    add(["deploy", "compose"], deploy.compose)
    add(["deploy", "path"], deploy.path)
  }
  if (deploy.type === "static") {
    add(["deploy", "root"], deploy.root)
    add(["deploy", "build", "image"], deploy.build?.image)
    add(["deploy", "build", "command"], deploy.build?.command)
  } else {
    for (const [name, value] of Object.entries(deploy.env ?? {})) {
      add(["deploy", "env", name], value)
    }
    if (deploy.ready && "command" in deploy.ready) {
      add(["deploy", "ready", "command"], deploy.ready.command)
    }
    add(["deploy", "hostname"], deploy.hostname)
  }
  if (deploy.type === "image" || deploy.type === "dockerfile") {
    deploy.command?.forEach((part, index) =>
      add(["deploy", "command", index], part)
    )
    deploy.files?.forEach((file, index) =>
      add(["deploy", "files", index, "content"], file.content)
    )
  }
  add(["database", "connection"], brick.database?.connection)
  add(["database", "backup"], brick.database?.backup)
  add(["database", "restore"], brick.database?.restore)
  return templates
}

function checkBrickV2(brick: BrickV2, context: z.RefinementCtx): void {
  const issue = (path: Array<string | number>, message: string) =>
    context.addIssue({ code: "custom", message, path })

  const inputs = brick.inputs ?? []
  const keys = new Set<string>()
  inputs.forEach((input, index) => {
    const path = ["inputs", index]
    if (keys.has(input.key)) issue([...path, "key"], "Use each key once")
    keys.add(input.key)
    checkInput(input, path, issue)
  })
  inputs.forEach((input, index) => {
    input.suggest?.forEach((rule, ruleIndex) => {
      const path = ["inputs", index, "suggest", ruleIndex]
      if (rule.when === input.key) {
        issue([...path, "when"], "A suggestion follows a different input")
      } else if (!keys.has(rule.when)) {
        issue([...path, "when"], `No input is called ${rule.when}`)
      }
      if (!brickV2Pattern(rule.matches)) {
        issue([...path, "matches"], "Not a valid regular expression")
      }
    })
  })

  for (const { path, template } of brickV2Templates(brick)) {
    for (const name of brickV2TemplateReferences(template)) {
      if (!keys.has(name) && !(name in brickV2Builtins)) {
        issue(path, `{{ ${name} }} isn't an input or a kiln.* value`)
      }
    }
  }

  const deploy = brick.deploy
  const ports = deploy.type === "static" ? [] : (deploy.ports ?? [])
  const portNames = new Set<string>()
  ports.forEach((port, index) => {
    if (portNames.has(port.name)) {
      issue(["deploy", "ports", index, "name"], "Use each port name once")
    }
    portNames.add(port.name)
    if (port.service && deploy.type !== "compose") {
      issue(
        ["deploy", "ports", index, "service"],
        "Only Compose ports name a service"
      )
    }
  })

  if (deploy.type === "image" || deploy.type === "dockerfile") {
    const volumes = deploy.volumes ?? []
    if (new Set(volumes).size !== volumes.length) {
      issue(["deploy", "volumes"], "Keep each folder once")
    }
  }
  if (deploy.type === "dockerfile" || deploy.type === "compose") {
    const written =
      deploy.type === "dockerfile" ? deploy.dockerfile : deploy.compose
    const label = deploy.type === "dockerfile" ? "Dockerfile" : "Compose file"
    if (written !== undefined && deploy.path !== undefined) {
      issue(["deploy", "path"], `Write the ${label} or point to one, not both`)
    }
    if (written === undefined && deploy.path === undefined) {
      issue(["deploy", "path"], `Write the ${label} or point to one`)
    }
  }
  if (
    deploy.type !== "static" &&
    deploy.ready &&
    "http" in deploy.ready &&
    deploy.ready.port &&
    !portNames.has(deploy.ready.port)
  ) {
    issue(["deploy", "ready", "port"], `No port is called ${deploy.ready.port}`)
  }

  if (brick.kind === "game-server") {
    if (!brick.game) issue(["game"], "Name the game it runs")
    if (deploy.type === "static") {
      issue(["deploy", "type"], "Game servers run in containers")
    }
    if (ports.length === 0)
      issue(["deploy", "ports"], "Add the port players join")
  } else if (brick.game !== undefined) {
    issue(["game"], "Only game servers name a game")
  }

  if (brick.kind === "database") {
    if (!brick.database) {
      issue(["database"], "Say how apps connect to it")
    }
    if (deploy.type === "static") {
      issue(["deploy", "type"], "Databases run in containers")
    }
    if (brick.database && !portNames.has(brick.database.port)) {
      issue(["database", "port"], `No port is called ${brick.database.port}`)
    }
    if (brick.database?.restore && !brick.database.backup) {
      issue(["database", "restore"], "Restore needs a backup to restore")
    }
  } else if (brick.database) {
    issue(["database"], "Only databases have a database block")
  }
}

function checkInput(
  input: BrickV2Input,
  path: Array<string | number>,
  issue: (path: Array<string | number>, message: string) => void
): void {
  const valueType =
    input.type === "number"
      ? "number"
      : input.type === "boolean"
        ? "boolean"
        : "string"
  const values = [
    ...(input.default === undefined ? [] : [input.default]),
    ...(input.suggest ?? []).map((rule) => rule.value),
  ]

  if (input.type === "select") {
    if (!input.options) issue([...path, "options"], "List its options")
    const allowed = new Set((input.options ?? []).map(brickV2OptionValue))
    for (const value of values) {
      if (typeof value === "boolean" || !allowed.has(value)) {
        issue([...path, "default"], `${String(value)} isn't one of its options`)
      }
    }
  } else {
    for (const value of values) {
      if (typeof value !== valueType) {
        issue(
          [...path, "default"],
          `Use a ${valueType} for a ${input.type} input`
        )
      }
    }
    if (input.options) {
      issue([...path, "options"], "Only select inputs have options")
    }
  }

  if (input.generate && input.type !== "secret") {
    issue([...path, "generate"], "Only secrets are generated")
  }
  if (input.generate && input.default !== undefined) {
    issue([...path, "default"], "A generated secret has no default")
  }
  if (input.pattern !== undefined) {
    if (input.type !== "text" && input.type !== "secret") {
      issue([...path, "pattern"], "Only text and secrets have a pattern")
    }
    const pattern = brickV2Pattern(input.pattern)
    if (!pattern) {
      issue([...path, "pattern"], "Not a valid regular expression")
    } else if (
      typeof input.default === "string" &&
      !pattern.test(input.default)
    ) {
      issue([...path, "default"], "The default doesn't match its pattern")
    }
  }
  if (
    (input.min !== undefined || input.max !== undefined) &&
    (input.type === "boolean" || input.type === "select")
  ) {
    issue([...path, "min"], `${input.type} inputs have no bounds`)
  }
  if (
    input.min !== undefined &&
    input.max !== undefined &&
    input.min > input.max
  ) {
    issue([...path, "max"], "max is below min")
  }
}
