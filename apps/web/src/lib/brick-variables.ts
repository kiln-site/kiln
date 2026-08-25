import {
  BRICK_INSTANCE_NAME_SUFFIX,
  RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH,
  requiredMinecraftJavaVersion,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"
import { Result } from "effect"

export const LONG_STRING_FIELD_MAX_LENGTH = 256

export function usesLongStringBrickField(
  definition: Brick["variables"][string]
): boolean {
  return (
    definition.type === "string" &&
    !definition.sensitive &&
    definition.options === undefined &&
    (definition.rules?.maxLength ?? 0) >= LONG_STRING_FIELD_MAX_LENGTH
  )
}

export function canPairMinecraftJavaVersionFields(
  definitions: Brick["variables"]
): boolean {
  return (
    definitions.version?.type === "string" &&
    definitions.java_version?.type === "string"
  )
}

export function updateBrickVariable(
  variables: Readonly<Record<string, BrickVariableValue>>,
  name: string,
  value: BrickVariableValue | undefined
): Record<string, BrickVariableValue> {
  const updated = { ...variables }
  if (value === undefined) delete updated[name]
  else updated[name] = value
  return updated
}

export function missingRequiredBrickVersion(
  definition: Brick["variables"][string] | undefined,
  submitted: unknown
): boolean {
  if (!definition?.required || definition.default !== undefined) return false
  return typeof submitted !== "string" || submitted.trim() === ""
}

export function defaultBrickVariables(
  brick: Brick
): Record<string, BrickVariableValue> {
  const variables = Object.fromEntries(
    Object.entries(brick.variables).flatMap(([name, definition]) =>
      definition.default === undefined ? [] : [[name, definition.default]]
    )
  )
  return withRecommendedMinecraftJava(
    brick.metadata.id,
    brick.variables,
    variables
  )
}

export function hydrateBrickVariables(
  brick: Brick,
  stored: Readonly<Record<string, BrickVariableValue>> | null | undefined
): Record<string, BrickVariableValue> {
  const variables = {
    ...defaultBrickVariables(brick),
    ...stored,
  }
  return stored && Object.hasOwn(stored, "java_version")
    ? variables
    : withRecommendedMinecraftJava(
        brick.metadata.id,
        brick.variables,
        variables
      )
}

const PUBLISHED_JAVA_EMBERS = ["11", "17", "21", "25"] as const

export function supportedJavaVersions(
  definition: Brick["variables"][string]
): Array<string> {
  if (definition.type !== "string") return []
  const candidates = definition.options?.length
    ? definition.options.map(String)
    : PUBLISHED_JAVA_EMBERS
  return candidates.filter((version) =>
    stringVariableAllows(definition, version)
  )
}

export function javaVersionSelectOptions(
  definition: Brick["variables"][string],
  current?: string
): Array<string> {
  const listed = supportedJavaVersions(definition)
  if (listed.length === 0) return []
  const extras = [
    current?.trim() || undefined,
    definition.default === undefined ? undefined : String(definition.default),
  ]
  const options = [...listed]
  for (const value of extras) {
    if (
      value &&
      !options.includes(value) &&
      stringVariableAllows(definition, value)
    ) {
      options.push(value)
    }
  }
  return options
}

export function recommendedSupportedJavaVersion(
  brickId: string,
  definition: Brick["variables"][string],
  minecraftVersion: string
): string | null {
  const supported = javaVersionSelectOptions(definition)
  if (supported.length === 0) return null
  const required = requiredMinecraftJavaVersion(brickId, minecraftVersion)
  if (required && supported.includes(required)) return required
  if (required && stringVariableAllows(definition, required)) return required
  const fallback =
    definition.default === undefined ? null : String(definition.default)
  if (fallback && stringVariableAllows(definition, fallback)) return fallback
  return supported.at(-1) ?? null
}

export function withRecommendedMinecraftJava(
  brickId: string,
  definitions: Brick["variables"],
  variables: Readonly<Record<string, BrickVariableValue>>
): Record<string, BrickVariableValue> {
  const updated = { ...variables }
  const version = variables.version
  const javaVersion =
    typeof version === "string"
      ? requiredMinecraftJavaVersion(brickId, version)
      : null
  const javaDefinition = definitions.java_version
  if (
    javaVersion &&
    javaDefinition &&
    stringVariableAllows(javaDefinition, javaVersion)
  ) {
    updated.java_version = javaVersion
  }
  return updated
}

export function unavailableMinecraftJavaVersion(
  brickId: string,
  definitions: Brick["variables"],
  version: string,
  selectedJavaVersion?: BrickVariableValue
): string | null {
  const javaVersion =
    typeof selectedJavaVersion === "string"
      ? selectedJavaVersion
      : requiredMinecraftJavaVersion(brickId, version)
  const javaDefinition = definitions.java_version
  if (!javaVersion || javaDefinition?.type !== "string") return null
  return stringVariableAllows(javaDefinition, javaVersion) ? null : javaVersion
}

export function stringVariableAllows(
  definition: Brick["variables"][string],
  value: string
): boolean {
  if (definition.type !== "string") return false
  if (
    definition.options &&
    !definition.options.some((option) => option === value)
  ) {
    return false
  }
  if (
    definition.rules?.minLength !== undefined &&
    value.length < definition.rules.minLength
  ) {
    return false
  }
  if (
    definition.rules?.maxLength !== undefined &&
    value.length > definition.rules.maxLength
  ) {
    return false
  }
  const patternSource = definition.rules?.pattern
  if (!patternSource) return true
  const pattern = Result.try(() => new RegExp(patternSource, "u"))
  return Result.isSuccess(pattern) && pattern.success.test(value)
}

export function defaultBrickInstanceName(brick: Brick): string {
  const brickName = brick.metadata.name
    .slice(0, RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH)
    .trimEnd()
  return `${brickName}${BRICK_INSTANCE_NAME_SUFFIX}`
}

export function latestStableVersion(
  versions: ReadonlyArray<string>
): string | null {
  const stableVersions = versions.flatMap((version) => {
    const trimmed = version.trim()
    return /^\d+(?:\.\d+)*$/u.test(trimmed) ? [trimmed] : []
  })

  if (stableVersions.length === 0) return null

  return [...stableVersions].sort(compareNumericVersions)[0] ?? null
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) return rightPart - leftPart
  }

  return rightParts.length - leftParts.length
}

export function interpolateBrickTemplate(
  template: string,
  values: Readonly<Record<string, BrickVariableValue>>,
  brick?: { id: string; name?: string }
): string {
  return template.replace(
    /\{\{\s*(variables\.([a-z][a-z0-9_]{0,47})|brick\.(id|name))\s*\}\}/gu,
    (
      match,
      _expression: string,
      variable: string | undefined,
      field: string | undefined
    ) => {
      if (variable) {
        if (!Object.hasOwn(values, variable)) return match
        const value = values[variable]
        return value === undefined ? match : String(value)
      }
      if (field === "name") return brick?.name ?? match
      if (field === "id") return brick?.id ?? match
      return match
    }
  )
}

export function interpolateBrickEnvironment(
  environment: Readonly<Record<string, string>>,
  values: Readonly<Record<string, BrickVariableValue>>,
  brick?: { id: string; name?: string }
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      interpolateBrickTemplate(value, values, brick),
    ])
  )
}

export function defaultBrickRuntimeName(brick: Brick): string {
  return interpolateBrickTemplate(
    brick.runtime.name,
    defaultBrickVariables(brick),
    { id: brick.metadata.id, name: brick.metadata.name }
  )
}
