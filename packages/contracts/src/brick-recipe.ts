import { Result } from "effect"
import { z } from "zod"

/**
 * `kiln.brick/v2`: the recipe for one instance, or for a group of them.
 * The spec, with examples, is `apps/bricks/docs/brick-v2.md`.
 *
 * Parsing never changes a recipe: no field has a default here, so what a
 * person wrote is what is stored and shown again. The defaults live with the
 * readers below (`brickPorts`, `brickInputOptional` and the like).
 */
export const BRICK_FORMAT = "kiln.brick/v2"

export const brickIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u)

export const brickKinds = ["game-server", "database", "app", "group"] as const
export type BrickKind = (typeof brickKinds)[number]

/**
 * The types Kiln has extras for, by kind. A Brick without one runs with the
 * foundation every instance has and nothing more.
 */
export const brickTypes = {
  "game-server": ["minecraft"],
  database: ["postgres", "mysql", "mariadb", "redis", "valkey"],
  app: [],
  group: [],
} as const satisfies Record<BrickKind, ReadonlyArray<string>>
export type BrickType = (typeof brickTypes)[BrickKind][number]

const inputKeyPattern = /^[a-z][a-z0-9_]{0,47}$/u
const namePattern = /^[a-z][a-z0-9-]{0,31}$/u
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/u

const inputKeySchema = z.string().regex(inputKeyPattern)
const nameSchema = z.string().regex(namePattern)
const templateSchema = z.string().max(8_192)

export const brickInputValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
])
export type BrickInputValue = z.infer<typeof brickInputValueSchema>

export const brickInputValuesSchema = z.record(
  inputKeySchema,
  brickInputValueSchema
)

/** A version as `suggest` compares it: dotted numbers, like `1.20.5`. */
const versionSchema = z.string().regex(/^\d+(?:\.\d+){0,3}$/u)

/**
 * A default that follows another answer. A rule applies when every condition
 * it names holds for the other input's value: `matches` is a regular
 * expression, `from` and `below` compare it as a version.
 */
export const brickSuggestRuleSchema = z
  .strictObject({
    when: inputKeySchema,
    matches: z.string().min(1).max(512).optional(),
    from: versionSchema.optional(),
    below: versionSchema.optional(),
    value: brickInputValueSchema,
  })
  .refine(
    (rule) =>
      rule.matches !== undefined ||
      rule.from !== undefined ||
      rule.below !== undefined,
    { message: "A suggest rule needs matches, from, or below" }
  )
export type BrickSuggestRule = z.infer<typeof brickSuggestRuleSchema>

const selectOptionSchema = brickInputValueSchema

export const brickInputSchema = z.strictObject({
  key: inputKeySchema,
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "boolean", "select", "secret"]),
  /** A line under the field. */
  help: z.string().min(1).max(280).optional(),
  default: brickInputValueSchema.optional(),
  /** Inputs are required unless this is true. */
  optional: z.boolean().optional(),
  /** Folds it under Advanced. */
  advanced: z.boolean().optional(),
  /** `select` only: the values to choose from, all of one type. */
  options: z.array(selectOptionSchema).min(1).max(64).optional(),
  /** A regular expression an answer that is text must match. */
  pattern: z.string().min(1).max(512).optional(),
  /** A number's bounds, or a text's length. */
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  /**
   * What it holds (its default, options and suggested values) is kept out
   * of what Kiln shows of a recipe, and its answer out of error messages. A
   * `secret` always is.
   */
  sensitive: z.boolean().optional(),
  /** `secret` only: Kiln makes a strong random value when none is given. */
  generate: z.boolean().optional(),
  suggest: z.array(brickSuggestRuleSchema).min(1).max(16).optional(),
})
export type BrickInput = z.infer<typeof brickInputSchema>

const portNumberSchema = z.number().int().min(1).max(65_535)

export const brickPortSchema = z.strictObject({
  name: nameSchema,
  /** The port it listens on, or one input's answer as `{{ key }}`. */
  port: z.union([
    portNumberSchema,
    z.string().regex(/^\{\{\s*[a-z][a-z0-9_]{0,47}\s*\}\}$/u),
  ]),
  /** `tcp` without it. */
  protocol: z.enum(["tcp", "udp", "both"]).optional(),
  /** How it is reached; each kind has its own default (`brickPortExpose`). */
  expose: z.enum(["public", "http", "private"]).optional(),
  /** A fixed port on the Relay. Kiln picks a free one without it. */
  host: portNumberSchema.optional(),
  /** `compose` only: the service that listens on it. */
  service: nameSchema.optional(),
})
export type BrickPort = z.infer<typeof brickPortSchema>

/** When it counts as started. Without one, once its first port answers. */
export const brickReadySchema = z.union([
  z.strictObject({
    log: z.array(z.string().trim().min(1).max(256)).min(1).max(8),
  }),
  z.strictObject({ command: z.string().min(1).max(2_048) }),
  z.strictObject({
    http: z.string().regex(/^\//u).max(512),
    port: nameSchema.optional(),
  }),
])
export type BrickReady = z.infer<typeof brickReadySchema>

const memorySchema = z.string().min(1).max(128)
const volumesSchema = z.array(z.string().regex(/^\//u).max(256)).min(1).max(8)

const deployShared = {
  /** Environment variables. Values take templates. */
  env: z.record(z.string().regex(environmentNamePattern), templateSchema),
  ports: z.array(brickPortSchema).min(1).max(16),
  ready: brickReadySchema,
  /** A starting memory limit like `2G`. The limit set in Hearth wins. */
  memory: memorySchema,
}

const containerShared = {
  /** What it runs on, shown beside the instance, like `Java 21`. */
  runtime: z.string().min(1).max(80),
  entrypoint: z.array(z.string().max(2_048)).min(1).max(32),
  command: z.array(z.string().max(2_048)).max(64),
  workingDirectory: z.string().regex(/^\//u).max(256),
  stopSignal: z.string().regex(/^SIG[A-Z0-9]+$/u),
  /** A numeric `user` or `user:group` to run as. */
  user: z.string().regex(/^[0-9]+(?::[0-9]+)?$/u),
  /** How many processes it may run; 512 without it. */
  pids: z.number().int().min(16).max(32_768),
  /** Paths kept across restarts. The first is the one Files opens. */
  volumes: volumesSchema,
}

const optional = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object(shape).partial().shape

export const brickDeploySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    image: z.string().min(1).max(512),
    ...optional(containerShared),
    ...optional(deployShared),
  }),
  z
    .strictObject({
      type: z.literal("dockerfile"),
      /** The Dockerfile itself, or `path` to one in the source. */
      dockerfile: z.string().min(1).max(65_536).optional(),
      path: z.string().min(1).max(1_024).optional(),
      ...optional(containerShared),
      ...optional(deployShared),
    })
    .refine(
      (deploy) =>
        (deploy.dockerfile === undefined) !== (deploy.path === undefined),
      { message: "Give either dockerfile or path" }
    ),
  z
    .strictObject({
      type: z.literal("compose"),
      /** The Compose file itself, or `path` to one in the source. */
      compose: z.string().min(1).max(262_144).optional(),
      path: z.string().min(1).max(1_024).optional(),
      /** The service whose console and logs open first. */
      service: nameSchema.optional(),
      ...optional(deployShared),
    })
    .refine(
      (deploy) =>
        (deploy.compose === undefined) !== (deploy.path === undefined),
      { message: "Give either compose or path" }
    ),
])
export type BrickDeploy = z.infer<typeof brickDeploySchema>

export const brickMetadataSchema = z.strictObject({
  id: brickIdSchema,
  name: z.string().min(1).max(80),
  /**
   * Which revision of the recipe this is: a whole number its author raises
   * when a change is one that instances already installed should be
   * offered. 1 without it.
   */
  revision: z.number().int().min(1).max(1_000_000).optional(),
  /** One line for the catalog. */
  summary: z.string().min(1).max(280),
  author: z.string().min(1).max(80),
  /**
   * A path beside the recipe, or an `https://` link. An SVG is a
   * single-colour mark; a PNG, WebP or JPEG is shown as it is.
   */
  icon: z.string().trim().min(1).max(2_048).optional(),
  color: z
    .string()
    .regex(/^#[\da-f]{6}$/iu, "Brick colors must use #rrggbb")
    .optional(),
  tags: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u))
    .max(12)
    .optional(),
  links: z
    .strictObject({
      homepage: z.url().max(2_048),
      source: z.url().max(2_048),
      docs: z.url().max(2_048),
      support: z.url().max(2_048),
    })
    .partial()
    .optional(),
  /** The CPU architectures it runs on. Any, without it. */
  platforms: z
    .array(z.enum(["amd64", "arm64"]))
    .min(1)
    .optional(),
})
export type BrickMetadata = z.infer<typeof brickMetadataSchema>

/**
 * What stays the same about where a Brick comes from, from one revision of
 * it to the next: which is how an instance installed from an older revision
 * finds the newer one. A catalog in a GitHub repository is read at a
 * commit, so its Bricks' sources name that commit; the same file at
 * another commit is the same Brick. Any other source is itself.
 */
export function brickSourceLineage(source: string): string {
  const match =
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/iu.exec(
      source
    )
  return match
    ? `github:${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}:${match[3]}`
    : source
}

/** A recipe's revision, which is 1 until its author says otherwise. */
export function brickRevision(recipe: {
  readonly metadata: Pick<BrickMetadata, "revision">
}): number {
  return recipe.metadata.revision ?? 1
}

/** What only a game server has. */
export const brickGameServerSchema = z.strictObject({
  /** The game it runs, which groups servers. Its name, without one. */
  game: z.string().min(1).max(80).optional(),
  /**
   * Console commands that stop it on purpose, so Kiln doesn't take the exit
   * for a crash and start it again.
   */
  stop: z.array(z.string().trim().min(1).max(128)).min(1).max(8).optional(),
  /** Whether players can join by name through an SRV record. */
  srv: z.boolean().optional(),
})

/** What only a database has. Commands run in its container. */
export const brickDatabaseSchema = z.strictObject({
  /** The URL handed to whatever connects to it. Takes templates. */
  connection: templateSchema.min(1),
  /** Writes a dump to stdout. Without it, backups copy the volume. */
  export: z.string().min(1).max(2_048).optional(),
  /** Reads a dump from stdin. */
  import: z.string().min(1).max(2_048).optional(),
})

/** What the `minecraft` type adds, and which of it this Brick uses. */
export const brickMinecraftSchema = z.strictObject({
  /**
   * Where the newest version comes from when `version` isn't answered at
   * install. `velocity` asks the Velocity download index.
   */
  latestVersion: z.enum(["velocity"]).optional(),
  /**
   * Whether its console completes commands when asked, as Paper's does.
   * Kiln asks by typing into the console, so only a server that answers
   * that way should say so.
   */
  completion: z.boolean().optional(),
})

// As many as a recipe has: v1 set no limit, and a document is at most 1 MiB.
const inputsSchema = z.array(brickInputSchema)

const instanceShape = {
  type: z.string().regex(namePattern).optional(),
  deploy: brickDeploySchema.optional(),
  "game-server": brickGameServerSchema.optional(),
  database: brickDatabaseSchema.optional(),
  minecraft: brickMinecraftSchema.optional(),
}

/**
 * One member of a group: another Brick by its ID or link, or a recipe
 * written here, which uses the group's inputs. `connect` names the members
 * it reaches and the environment variables it gets for each.
 */
const connectSchema = z.record(
  nameSchema,
  z.record(z.string().regex(environmentNamePattern), templateSchema)
)
export const brickGroupMemberSchema = z.union([
  z.strictObject({
    brick: z.union([brickIdSchema, z.url().max(2_048)]),
    /** Answers for that Brick's inputs. Values take the group's templates. */
    inputs: z.record(inputKeySchema, brickInputValueSchema).optional(),
    connect: connectSchema.optional(),
  }),
  z.strictObject({
    kind: z.enum(["game-server", "database", "app"]),
    name: z.string().min(1).max(80).optional(),
    ...instanceShape,
    connect: connectSchema.optional(),
  }),
])
export type BrickGroupMember = z.infer<typeof brickGroupMemberSchema>

export const brickGroupSchema = z.strictObject({
  members: z
    .record(nameSchema, brickGroupMemberSchema)
    .refine((members) => Object.keys(members).length >= 1, {
      message: "A group needs at least one member",
    })
    .refine((members) => Object.keys(members).length <= 16, {
      message: "A group can have at most 16 members",
    }),
})

/** What a group member's `connect` values can name of the member reached. */
export const brickConnectionTemplateNames = [
  "connection",
  "host",
  "port",
  "name",
  "username",
  "password",
] as const

/** What Kiln supplies to a database Brick's templates. */
const databaseTemplateNames = [
  "database.name",
  "database.username",
  "database.password",
  "database.host",
  "database.port",
] as const

const brickTemplateNames = ["brick.id", "brick.name"] as const

/**
 * The parts of `deploy` that take templates. A command, an entrypoint and a
 * Dockerfile or Compose file are passed on as they are written.
 */
export const brickDeployTemplateFields = [
  "image",
  "runtime",
  "env",
  "memory",
] as const

const templateExpression = /\{\{\s*([a-z][a-z0-9_.]{0,63})\s*\}\}/gu

/** The names a template asks for, as in `{{ version }}` or `{{ brick.id }}`. */
export function brickTemplateReferences(template: string): Array<string> {
  return Array.from(template.matchAll(templateExpression), (match) => match[1]!)
}

/** Whether a string is nothing but one input's answer, and whose. */
export function brickTemplateInput(template: string): string | null {
  return template.match(/^\{\{\s*([a-z][a-z0-9_]{0,47})\s*\}\}$/u)?.[1] ?? null
}

function malformedTemplate(template: string): boolean {
  const rest = template.replace(templateExpression, "")
  return rest.includes("{{") || rest.includes("}}")
}

type Issue = (path: ReadonlyArray<PropertyKey>, message: string) => void

function inputValueType(input: BrickInput): "string" | "number" | "boolean" {
  if (input.type === "number") return "number"
  if (input.type === "boolean") return "boolean"
  if (input.type === "select") {
    const option = input.options?.[0]
    return typeof option === "number"
      ? "number"
      : typeof option === "boolean"
        ? "boolean"
        : "string"
  }
  return "string"
}

function checkInputs(
  inputs: ReadonlyArray<BrickInput>,
  path: ReadonlyArray<PropertyKey>,
  issue: Issue
): void {
  const keys = new Set<string>()
  inputs.forEach((input, index) => {
    const at = [...path, index]
    if (keys.has(input.key))
      issue([...at, "key"], `Duplicate input ${input.key}`)
    keys.add(input.key)
    if (input.type === "select") {
      if (!input.options) issue([...at, "options"], "A select needs options")
      else if (new Set(input.options.map((option) => typeof option)).size > 1) {
        issue([...at, "options"], "Options must all be of one type")
      }
    } else if (input.options) {
      issue([...at, "options"], "Only a select has options")
    }
    if (input.generate && input.type !== "secret") {
      issue([...at, "generate"], "Only a secret can be generated")
    }
    const type = inputValueType(input)
    if (input.pattern !== undefined) {
      if (type !== "string") {
        issue([...at, "pattern"], "Only an answer that is text takes a pattern")
      } else if (!validPattern(input.pattern)) {
        issue([...at, "pattern"], "Not a valid regular expression")
      }
    }
    if (
      (input.min !== undefined || input.max !== undefined) &&
      type === "boolean"
    ) {
      issue(at, "Only text and numbers take min and max")
    }
    if (input.default !== undefined) {
      if (typeof input.default !== type) {
        issue([...at, "default"], `The default must be a ${type}`)
      } else if (
        input.options &&
        !input.options.includes(input.default as never)
      ) {
        issue([...at, "default"], "The default must be one of the options")
      }
    }
    // Round in a circle, no set of answers has to satisfy every rule.
    if (
      input.suggest?.every((rule) => rule.when !== input.key) &&
      followsItself(input, inputs)
    ) {
      issue([...at, "suggest"], "Inputs can't follow each other in a circle")
    }
    input.suggest?.forEach((rule, ruleIndex) => {
      const rulePath = [...at, "suggest", ruleIndex]
      if (typeof rule.value !== type) {
        issue([...rulePath, "value"], `The value must be a ${type}`)
      }
      if (rule.when === input.key) {
        issue([...rulePath, "when"], "An input can't follow its own answer")
      } else {
        const followed = inputs.find((other) => other.key === rule.when)
        if (!followed) {
          issue([...rulePath, "when"], `No input is named ${rule.when}`)
        } else if (followed.generate) {
          // Kiln makes it at install, after every answer is worked out.
          issue(
            [...rulePath, "when"],
            "An input can't follow a secret Kiln generates"
          )
        }
      }
      if (rule.matches !== undefined && !validPattern(rule.matches)) {
        issue([...rulePath, "matches"], "Not a valid regular expression")
      }
    })
  })
}

/** Whether an input follows itself, through however many others. */
function followsItself(
  input: BrickInput,
  inputs: ReadonlyArray<BrickInput>
): boolean {
  const seen = new Set<string>()
  const pending = (input.suggest ?? []).map((rule) => rule.when)
  while (pending.length > 0) {
    const key = pending.pop()!
    if (key === input.key) return true
    if (seen.has(key)) continue
    seen.add(key)
    const followed = inputs.find((other) => other.key === key)
    for (const rule of followed?.suggest ?? []) pending.push(rule.when)
  }
  return false
}

function validPattern(pattern: string): boolean {
  return compiled(pattern) !== null
}

function checkTemplates(
  value: unknown,
  known: ReadonlySet<string>,
  path: ReadonlyArray<PropertyKey>,
  issue: Issue
): void {
  if (typeof value === "string") {
    if (malformedTemplate(value)) {
      issue(path, "Templates are written {{ name }}")
      return
    }
    for (const name of brickTemplateReferences(value)) {
      if (!known.has(name)) issue(path, `Nothing is named ${name}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkTemplates(item, known, [...path, index], issue)
    )
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      checkTemplates(item, known, [...path, key], issue)
    }
  }
}

function checkDeploy(
  kind: Exclude<BrickKind, "group">,
  deploy: BrickDeploy,
  inputs: ReadonlyArray<BrickInput>,
  path: ReadonlyArray<PropertyKey>,
  issue: Issue
): void {
  const names = new Set<string>()
  deploy.ports?.forEach((port, index) => {
    const at = [...path, "ports", index]
    if (names.has(port.name))
      issue([...at, "name"], `Duplicate port ${port.name}`)
    names.add(port.name)
    if (port.service !== undefined && deploy.type !== "compose") {
      issue([...at, "service"], "Only a Compose project names a port's service")
    }
    if (
      port.host !== undefined &&
      (port.expose ?? brickDefaultExpose[kind]) !== "public"
    ) {
      issue([...at, "host"], "Only a public port takes a fixed host port")
    }
    if (typeof port.port === "string") {
      const key = brickTemplateInput(port.port)
      if (inputs.find((input) => input.key === key)?.type !== "number") {
        issue([...at, "port"], "A port from an input needs a number input")
      }
    }
  })
  const ready = deploy.ready
  if (
    ready &&
    "http" in ready &&
    ready.port !== undefined &&
    !names.has(ready.port)
  ) {
    issue([...path, "ready", "port"], `No port is named ${ready.port}`)
  }
}

function checkInstance(
  recipe: {
    kind: Exclude<BrickKind, "group">
    type?: string | undefined
    inputs?: ReadonlyArray<BrickInput> | undefined
    deploy?: BrickDeploy | undefined
    "game-server"?: unknown
    database?: unknown
    minecraft?: unknown
  },
  templates: ReadonlyArray<string>,
  path: ReadonlyArray<PropertyKey>,
  issue: Issue
): void {
  const { kind } = recipe
  if (
    recipe.type !== undefined &&
    !(brickTypes[kind] as ReadonlyArray<string>).includes(recipe.type)
  ) {
    const known = brickTypes[kind]
    issue(
      [...path, "type"],
      known.length > 0
        ? `A ${kind} can be ${known.join(" or ")}, or have no type`
        : `A ${kind} has no types`
    )
  }
  const inputs = recipe.inputs ?? []
  checkInputs(inputs, [...path, "inputs"], issue)
  if (!recipe.deploy) {
    issue([...path, "deploy"], "Say how it runs")
  } else {
    checkDeploy(kind, recipe.deploy, inputs, [...path, "deploy"], issue)
  }
  if (recipe["game-server"] !== undefined && kind !== "game-server") {
    issue([...path, "game-server"], "Only a game server has this section")
  }
  if (recipe.database !== undefined && kind !== "database") {
    issue([...path, "database"], "Only a database has this section")
  }
  if (kind === "database" && recipe.database === undefined) {
    issue([...path, "database"], "A database says how to connect to it")
  }
  if (recipe.minecraft !== undefined && recipe.type !== "minecraft") {
    issue([...path, "minecraft"], "Only the minecraft type has this section")
  }
  const known = new Set<string>([
    ...templates,
    ...inputs.map((input) => input.key),
    ...(kind === "database" ? databaseTemplateNames : []),
  ])
  for (const field of brickDeployTemplateFields) {
    const deploy: Record<string, unknown> | undefined = recipe.deploy
    checkTemplates(deploy?.[field], known, [...path, "deploy", field], issue)
  }
  checkTemplates(recipe.database, known, [...path, "database"], issue)
}

const recipeShape = {
  format: z.literal(BRICK_FORMAT),
  kind: z.enum(brickKinds),
  metadata: brickMetadataSchema,
  inputs: inputsSchema.optional(),
  ...instanceShape,
  group: brickGroupSchema.optional(),
}

function checkRecipe(
  recipe: z.infer<z.ZodObject<typeof recipeShape>>,
  context: z.RefinementCtx
): void {
  const issue: Issue = (path, message) =>
    context.addIssue({ code: "custom", message, path: [...path] })
  if (recipe.kind !== "group") {
    if (recipe.group !== undefined) {
      issue(["group"], "Only a group has members")
    }
    checkInstance(
      { ...recipe, kind: recipe.kind },
      brickTemplateNames,
      [],
      issue
    )
    return
  }
  for (const section of [
    "type",
    "deploy",
    "game-server",
    "database",
    "minecraft",
  ] as const) {
    if (recipe[section] !== undefined) {
      issue([section], "A group runs nothing itself; its members do")
    }
  }
  const inputs = recipe.inputs ?? []
  checkInputs(inputs, ["inputs"], issue)
  if (!recipe.group) {
    issue(["group"], "A group lists its members")
    return
  }
  const groupTemplates = [
    ...brickTemplateNames,
    ...inputs.map((input) => input.key),
  ]
  const members = Object.keys(recipe.group.members)
  for (const [name, member] of Object.entries(recipe.group.members)) {
    const path = ["group", "members", name]
    if ("brick" in member) {
      checkTemplates(
        member.inputs,
        new Set(groupTemplates),
        [...path, "inputs"],
        issue
      )
    } else {
      // Written here, it takes the group's inputs: it has none of its own.
      checkInstance({ ...member, inputs }, brickTemplateNames, path, issue)
    }
    for (const [target, variables] of Object.entries(member.connect ?? {})) {
      const connectPath = [...path, "connect", target]
      if (target === name) {
        issue(connectPath, "A member can't connect to itself")
      } else if (!members.includes(target)) {
        issue(connectPath, `No member is named ${target}`)
      }
      checkTemplates(
        variables,
        new Set([...groupTemplates, ...brickConnectionTemplateNames]),
        connectPath,
        issue
      )
    }
  }
}

export const brickRecipeSchema = z
  .strictObject(recipeShape)
  .superRefine(checkRecipe)
export type BrickRecipe = z.infer<typeof brickRecipeSchema>

export const brickSourceSchema = z.string().trim().url().max(2_048)

/**
 * A recipe with where it was read from, and its icon as Kiln snapshotted it
 * when that was an SVG mark.
 */
export const brickSchema = z
  .strictObject({
    ...recipeShape,
    iconSvg: z
      .string()
      .max(64 * 1024)
      .optional(),
    source: brickSourceSchema,
  })
  .superRefine(checkRecipe)
export type Brick = z.infer<typeof brickSchema>

/** How a port is reached when it doesn't say. */
export const brickDefaultExpose = {
  "game-server": "public",
  app: "http",
  database: "private",
} as const satisfies Record<
  Exclude<BrickKind, "group">,
  NonNullable<BrickPort["expose"]>
>

/** Whether an answer must be given. */
export function brickInputRequired(input: BrickInput): boolean {
  return input.optional !== true
}

/** The type of value an input holds. */
export function brickInputValueType(
  input: BrickInput
): "string" | "number" | "boolean" {
  return inputValueType(input)
}

/** Why a value doesn't fit an input, or null when it does. */
export function brickInputProblem(
  input: BrickInput,
  value: BrickInputValue
): string | null {
  const type = inputValueType(input)
  if (typeof value !== type) {
    return `must be ${type === "string" ? "text" : `a ${type}`}`
  }
  if (
    input.options &&
    !input.options.some((option) => Object.is(option, value))
  ) {
    return "must be one of its options"
  }
  if (typeof value === "string") {
    if (input.min !== undefined && value.length < input.min) {
      return `must be at least ${input.min} characters`
    }
    if (input.max !== undefined && value.length > input.max) {
      return `must be at most ${input.max} characters`
    }
    if (input.pattern !== undefined) {
      const pattern = compiled(input.pattern)
      if (!pattern || !pattern.test(value))
        return "isn't in the form it asks for"
    }
  }
  if (typeof value === "number") {
    if (input.min !== undefined && value < input.min) {
      return `must be at least ${input.min}`
    }
    if (input.max !== undefined && value > input.max) {
      return `must be at most ${input.max}`
    }
  }
  return null
}

function compiled(pattern: string): RegExp | null {
  return Result.getOrNull(Result.try(() => new RegExp(pattern, "u")))
}

function versionParts(value: string): Array<number> | null {
  // A suffix such as `-SNAPSHOT` doesn't change where a version sorts.
  const match = value.trim().match(/^(\d+(?:\.\d+)*)/u)
  if (!match?.[1]) return null
  const parts = match[1].split(".").map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

function compareVersions(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>
): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function ruleApplies(rule: BrickSuggestRule, value: BrickInputValue): boolean {
  const text = String(value)
  if (rule.matches !== undefined) {
    const pattern = compiled(rule.matches)
    if (!pattern || !pattern.test(text)) return false
  }
  if (rule.from !== undefined || rule.below !== undefined) {
    const version = versionParts(text)
    if (!version) return false
    if (
      rule.from !== undefined &&
      compareVersions(version, versionParts(rule.from)!) < 0
    ) {
      return false
    }
    if (
      rule.below !== undefined &&
      compareVersions(version, versionParts(rule.below)!) >= 0
    ) {
      return false
    }
  }
  return true
}

/** The first of an input's `suggest` rules that applies to these answers. */
function appliedSuggestRule(
  input: BrickInput,
  values: Readonly<Record<string, BrickInputValue>>
): BrickSuggestRule | undefined {
  return input.suggest?.find((rule) => {
    if (!Object.hasOwn(values, rule.when)) return false
    const value = values[rule.when]
    return value !== undefined && ruleApplies(rule, value)
  })
}

/**
 * The value an input's `suggest` rules give for the other answers: the first
 * rule that applies. Undefined when it has no rules or none applies, which
 * leaves its own default.
 */
export function brickSuggestedValue(
  input: BrickInput,
  values: Readonly<Record<string, BrickInputValue>>
): BrickInputValue | undefined {
  return appliedSuggestRule(input, values)?.value
}

/**
 * Every input's answer. One that was given stands as it is. Any other is
 * the first of its `suggest` rules that applies to the answers there are,
 * else its own default, else nothing.
 *
 * Inputs can follow each other in any order of the form, and through one
 * another, so they are worked out until nothing changes. The format refuses
 * rules that go round in a circle, so that always ends; the pass per input
 * is only a bound.
 *
 * It fills in what the rules say, allowed or not: `brickAnswersProblem`
 * says what is wrong with the result.
 *
 * Without `worked`, every input that wasn't given an answer is worked out.
 * With it, only those are, and the rest stay as given, unanswered included:
 * a form uses that when one answer changes (`brickFollowers`).
 */
export function brickAnswers(
  inputs: ReadonlyArray<BrickInput>,
  given: Readonly<Record<string, BrickInputValue>>,
  worked?: ReadonlySet<string>
): Record<string, BrickInputValue> {
  const answers: Record<string, BrickInputValue> = {}
  const working = inputs.filter((input) =>
    worked ? worked.has(input.key) : !Object.hasOwn(given, input.key)
  )
  for (const input of inputs) {
    const value = working.includes(input)
      ? input.default
      : Object.hasOwn(given, input.key)
        ? given[input.key]
        : undefined
    if (value !== undefined) answers[input.key] = value
  }
  for (let pass = 0; pass <= working.length; pass += 1) {
    let changed = false
    for (const input of working) {
      const next = brickSuggestedValue(input, answers) ?? input.default
      if (Object.is(next, answers[input.key])) continue
      if (next === undefined) delete answers[input.key]
      else answers[input.key] = next
      changed = true
    }
    if (!changed) break
  }
  return answers
}

/**
 * The inputs that follow `changed`, directly or through another input:
 * the ones to work out again when its answer changes.
 */
export function brickFollowers(
  inputs: ReadonlyArray<BrickInput>,
  changed: string
): Set<string> {
  const followers = new Set<string>()
  const sources = new Set([changed])
  for (let grew = true; grew;) {
    grew = false
    for (const input of inputs) {
      if (input.key === changed || followers.has(input.key)) continue
      if (!input.suggest?.some((rule) => sources.has(rule.when))) continue
      followers.add(input.key)
      sources.add(input.key)
      grew = true
    }
  }
  return followers
}

/** Whether an input's answer is kept out of what Kiln shows: a secret's is. */
export function brickInputSensitive(input: BrickInput): boolean {
  return input.type === "secret" || input.sensitive === true
}

export interface BrickAnswerProblem {
  readonly code: "missing" | "invalid" | "unsupported_suggestion"
  readonly key: string
  /** For whoever is installing it. Never holds a sensitive input's value. */
  readonly message: string
}

/**
 * The first thing wrong with a set of answers, or null: a required input
 * with none, an answer its input refuses, or a value that an input's rules
 * asked for and the input itself doesn't offer. That last one is refused
 * and never replaced, so nothing runs on a value nobody chose.
 */
export function brickAnswersProblem(
  inputs: ReadonlyArray<BrickInput>,
  answers: Readonly<Record<string, BrickInputValue>>
): BrickAnswerProblem | null {
  for (const input of inputs) {
    const { key } = input
    if (!Object.hasOwn(answers, key) || answers[key] === undefined) {
      // Kiln makes a generated secret when it installs the Brick.
      const made = input.type === "secret" && input.generate === true
      if (brickInputRequired(input) && !made) {
        return { code: "missing", key, message: `${input.label} is required` }
      }
      continue
    }
    const value = answers[key]
    const problem = brickInputProblem(input, value)
    if (!problem) continue
    // Refused because its rules asked for it, when that is where it is from.
    const rule = appliedSuggestRule(input, answers)
    const source =
      rule && Object.is(rule.value, value)
        ? inputs.find((other) => other.key === rule.when)
        : undefined
    if (!source) {
      return { code: "invalid", key, message: `${input.label} ${problem}` }
    }
    const hidden = brickInputSensitive(input) || brickInputSensitive(source)
    return {
      code: "unsupported_suggestion",
      key,
      message: hidden
        ? `${source.label} needs a ${input.label} this Brick doesn't offer`
        : `${source.label} ${String(answers[source.key])} needs ${input.label} ${String(value)}, which this Brick doesn't offer`,
    }
  }
  return null
}

/**
 * A recipe's inputs as they may be shown: a sensitive input's default,
 * options and suggested values are replaced, since a recipe can carry a real
 * value in any of them.
 */
export function redactedBrickInputs(
  inputs: ReadonlyArray<BrickInput>
): Array<BrickInput> {
  const redacted = "[redacted]"
  return inputs.map((input) =>
    brickInputSensitive(input)
      ? {
          ...input,
          ...(input.default === undefined ? {} : { default: redacted }),
          ...(input.options === undefined
            ? {}
            : { options: input.options.map(() => redacted) }),
          ...(input.suggest === undefined
            ? {}
            : {
                suggest: input.suggest.map((rule) => ({
                  ...rule,
                  value: redacted,
                })),
              }),
        }
      : input
  )
}

/** A recipe's install form, in order. */
export function brickInputs(
  recipe: Pick<BrickRecipe, "inputs">
): ReadonlyArray<BrickInput> {
  return recipe.inputs ?? []
}

/** The game a game server Brick runs: its own name when it names none. */
export function brickGame(
  recipe: Pick<BrickRecipe, "game-server" | "metadata">
): string {
  return recipe["game-server"]?.game ?? recipe.metadata.name
}

/**
 * The input a recipe's memory limit comes from, when it is one input's
 * answer and nothing else, as recipes converted from v1 have. Hearth's own
 * limit stands in for that input, which stays out of the form.
 */
export function brickMemoryInput(
  recipe: Pick<BrickRecipe, "deploy">
): string | null {
  const memory = recipe.deploy?.memory
  return memory === undefined ? null : brickTemplateInput(memory)
}

/**
 * A template with each `{{ name }}` replaced by what `lookup` gives for it.
 * A name it gives nothing for is left as written.
 */
export function fillBrickTemplate(
  template: string,
  lookup: (name: string) => string | undefined
): string {
  return template.replace(
    templateExpression,
    (match, name: string) => lookup(name) ?? match
  )
}
