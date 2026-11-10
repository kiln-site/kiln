import type { z } from "zod"

import {
  BRICK_FORMAT,
  brickRecipeSchema,
  brickSchema,
  type Brick,
  type BrickInput,
  type BrickPort,
  type BrickRecipe,
  type BrickSuggestRule,
} from "./brick-recipe.js"
import {
  brickRecipeV1Schema,
  type BrickRecipeV1,
  type BrickVariableV1,
} from "./brick-v1.js"

/**
 * Reading a Brick wherever one was stored or fetched: a `kiln.brick/v2`
 * recipe as it is, and a `kiln.brick/v1` one converted. Everything that
 * reads a recipe reads it through here, so nothing else knows v1.
 */
export type BrickRecipeRead =
  | { readonly success: true; readonly data: BrickRecipe }
  | { readonly success: false; readonly error: z.ZodError }

export function readBrickRecipe(document: unknown): BrickRecipeRead {
  if (documentFormat(document) !== "kiln.brick/v1") {
    return brickRecipeSchema.safeParse(document)
  }
  const v1 = brickRecipeV1Schema.safeParse(document)
  if (!v1.success) return v1
  // A v1 recipe that says something v2 can't is refused as v2 would refuse
  // it, with the converted recipe's own paths.
  return brickRecipeSchema.safeParse(convertedFromV1(v1.data))
}

function documentFormat(document: unknown): unknown {
  return document && typeof document === "object" && "format" in document
    ? document.format
    : undefined
}

/** A v1 recipe as the v2 recipe that runs the same thing. */
export function brickRecipeFromV1(recipe: BrickRecipeV1): BrickRecipe {
  return brickRecipeSchema.parse(convertedFromV1(recipe))
}

// Which Java each release needs was written into Kiln for these four Bricks,
// keyed by their ID. A v2 Brick says it in `suggest`; a converted one gets
// the rules Kiln used. They are a record of what v1 did, not a list to keep
// current: a new release's Java goes in that Brick's own `suggest` rules.
type JavaRule = Omit<BrickSuggestRule, "when">
const paperJava: ReadonlyArray<JavaRule> = [
  { from: "26.1", below: "27", value: "25" },
  { from: "1.20", below: "1.22", value: "21" },
  { from: "1.17", below: "1.20", value: "17" },
  { from: "1.16.5", below: "1.17", value: "16" },
  { from: "1.12", below: "1.16.5", value: "11" },
  { from: "1.7", below: "1.12", value: "8" },
]
const fabricJava: ReadonlyArray<JavaRule> = [
  { from: "26.1", below: "27", value: "25" },
  { from: "1.20.5", below: "1.22", value: "21" },
  { from: "1.17", below: "1.20.5", value: "17" },
  { from: "1.1", below: "1.17", value: "8" },
]
const velocityJava: ReadonlyArray<JavaRule> = [
  { from: "4", value: "25" },
  { from: "3.5", value: "21" },
  { from: "3.3", value: "17" },
  { from: "1", value: "11" },
]
// A Map, since a Brick may be named anything: `constructor` is a valid ID.
const minecraftJava = new Map<string, ReadonlyArray<JavaRule>>([
  ["paper", paperJava],
  ["folia", paperJava],
  ["fabric", fabricJava],
  ["velocity", velocityJava],
])

function template(value: string): string {
  return value.replace(
    /\{\{\s*variables\.([a-z][a-z0-9_]{0,47})\s*\}\}/gu,
    (_match, key: string) => `{{ ${key} }}`
  )
}

// An input that refuses exactly the answers its variable refused: v1 checked
// an answer's type, then its options, then the rules for that type.
function inputFromVariable(key: string, variable: BrickVariableV1): BrickInput {
  const rules = variable.rules
  const limits =
    variable.type === "string"
      ? {
          ...(rules?.pattern ? { pattern: rules.pattern } : {}),
          ...(rules?.minLength === undefined ? {} : { min: rules.minLength }),
          ...(rules?.maxLength === undefined ? {} : { max: rules.maxLength }),
        }
      : variable.type === "number"
        ? {
            ...(rules?.min === undefined ? {} : { min: rules.min }),
            ...(rules?.max === undefined ? {} : { max: rules.max }),
          }
        : {}
  const options = variable.options
  // A default that isn't an option could never be used.
  const usable =
    variable.default !== undefined &&
    (!options || options.some((option) => Object.is(option, variable.default)))
  const type = options
    ? "select"
    : variable.type === "string"
      ? variable.sensitive
        ? "secret"
        : "text"
      : variable.type
  return {
    key,
    label: variable.label,
    help: variable.description,
    type,
    ...(variable.required ? {} : { optional: true }),
    ...(options ? { options } : {}),
    ...(usable ? { default: variable.default } : {}),
    ...limits,
    // A secret is sensitive by its type.
    ...(variable.sensitive && type !== "secret" ? { sensitive: true } : {}),
  }
}

function convertedFromV1(recipe: BrickRecipeV1): unknown {
  const { metadata, runtime, network } = recipe
  const minecraft = network.mode === "minecraft-backend"
  const javaRules =
    recipe.variables.version?.type === "string" &&
    recipe.variables.java_version?.type === "string"
      ? minecraftJava.get(metadata.id)
      : undefined
  const inputs = Object.entries(recipe.variables).map(([key, variable]) => {
    const input = inputFromVariable(key, variable)
    return key === "java_version" && javaRules
      ? {
          ...input,
          suggest: javaRules.map((rule) => ({ when: "version", ...rule })),
        }
      : input
  })
  // The primary port is the first one.
  const ports: Array<BrickPort> = [...network.ports]
    .sort(
      (left, right) =>
        Number(right.name === network.primaryPort) -
        Number(left.name === network.primaryPort)
    )
    .map((port) => ({
      name: port.name,
      port: port.container,
      ...(port.protocol === "tcp" ? {} : { protocol: port.protocol }),
      ...(port.host === undefined ? {} : { host: port.host }),
    }))
  return {
    format: BRICK_FORMAT,
    kind: "game-server",
    ...(minecraft ? { type: "minecraft" } : {}),
    metadata: {
      id: metadata.id,
      name: metadata.name,
      summary: metadata.description,
      author: metadata.author,
      ...(metadata.icon ? { icon: metadata.icon } : {}),
      ...(metadata.color ? { color: metadata.color } : {}),
      ...(metadata.tags ? { tags: metadata.tags } : {}),
      ...(metadata.documentation
        ? { links: { docs: metadata.documentation } }
        : {}),
      ...(recipe.constraints.architectures
        ? { platforms: recipe.constraints.architectures }
        : {}),
    },
    ...(inputs.length > 0 ? { inputs } : {}),
    deploy: {
      type: "image",
      image: template(runtime.image),
      runtime: template(runtime.name),
      ...(runtime.user ? { user: runtime.user } : {}),
      ...(runtime.entrypoint?.length ? { entrypoint: runtime.entrypoint } : {}),
      ...(runtime.command ? { command: runtime.command } : {}),
      ...(runtime.workingDirectory
        ? { workingDirectory: runtime.workingDirectory }
        : {}),
      ...(runtime.stopSignal ? { stopSignal: runtime.stopSignal } : {}),
      env: Object.fromEntries(
        Object.entries(runtime.environment).map(([name, value]) => [
          name,
          template(value),
        ])
      ),
      memory: template(runtime.resources.memory),
      pids: runtime.resources.pids,
      volumes: [runtime.storage.mount],
      ports,
      ...(recipe.readiness ? { ready: { log: recipe.readiness.logs } } : {}),
    },
    "game-server": {
      game: metadata.game,
      ...(recipe.console ? { stop: recipe.console.stopCommands } : {}),
      ...(network.supportsSrv ? { srv: true } : {}),
    },
    ...(minecraft && metadata.id === "velocity"
      ? { minecraft: { latestVersion: "velocity" } }
      : {}),
  }
}

export type BrickRead =
  | { readonly success: true; readonly data: Brick }
  | { readonly success: false; readonly error: z.ZodError }

/**
 * Reading a Brick as Hearth and a Relay hand it around: a recipe with its
 * `source`, and its icon when one was snapshotted. One stored while recipes
 * were v1 is converted.
 */
export function readBrick(document: unknown): BrickRead {
  if (documentFormat(document) !== "kiln.brick/v1") {
    return brickSchema.safeParse(document)
  }
  const { iconSvg, source, ...recipe } = document as Record<string, unknown>
  const read = readBrickRecipe(recipe)
  if (!read.success) return read
  return brickSchema.safeParse({
    ...read.data,
    ...(iconSvg === undefined ? {} : { iconSvg }),
    source,
  })
}
