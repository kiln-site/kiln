import {
  BRICK_INSTANCE_NAME_SUFFIX,
  RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH,
  brickAnswers,
  brickFollowers,
  brickInputProblem,
  brickInputSensitive,
  brickInputValueType,
  brickInputs,
  fillBrickTemplate,
  type Brick,
  type BrickInput,
  type BrickVariableValue,
} from "@workspace/contracts"

export const LONG_STRING_FIELD_MAX_LENGTH = 256

/** A Brick's inputs by their key, in the order of its form. */
export type BrickFields = Readonly<Record<string, BrickInput>>

export function brickFields(brick: Pick<Brick, "inputs">): BrickFields {
  return Object.fromEntries(
    brickInputs(brick).map((input) => [input.key, input])
  )
}

/** Whether an input's answer is text, as a text, a secret or a text select is. */
export function isTextBrickField(definition: BrickInput): boolean {
  return brickInputValueType(definition) === "string"
}

export function usesLongStringBrickField(definition: BrickInput): boolean {
  return (
    definition.type === "text" &&
    !brickInputSensitive(definition) &&
    (definition.max ?? 0) >= LONG_STRING_FIELD_MAX_LENGTH
  )
}

export function canPairMinecraftJavaVersionFields(
  definitions: BrickFields
): boolean {
  const { version, java_version: java } = definitions
  return Boolean(
    version &&
    isTextBrickField(version) &&
    java &&
    isTextBrickField(java) &&
    // The pair shows both answers; a sensitive one keeps its own field.
    !brickInputSensitive(version) &&
    !brickInputSensitive(java)
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

export function defaultBrickVariables(
  brick: Pick<Brick, "inputs">
): Record<string, BrickVariableValue> {
  return brickAnswers(brickInputs(brick), {})
}

export function hydrateBrickVariables(
  brick: Pick<Brick, "inputs">,
  stored: Readonly<Record<string, BrickVariableValue>> | null | undefined
): Record<string, BrickVariableValue> {
  const inputs = brickInputs(brick)
  // An answer to an input this Brick doesn't have, as one kept from another
  // Brick, would be refused.
  const answered = Object.fromEntries(
    Object.entries(stored ?? {}).filter(([name]) =>
      inputs.some((input) => input.key === name)
    )
  )
  // What was answered stays; what wasn't follows the answers there are.
  return brickAnswers(inputs, answered)
}

/**
 * Answers after `changed` was answered: everything that follows it, directly
 * or through another input, is worked out again. Nothing else moves.
 *
 * Cleared, `changed` is worked out again too: its Relay gives an input
 * nobody answered its rule or its default, so the form holds that, and what
 * follows it follows the value the server will run with.
 */
export function withBrickVariableChanged(
  definitions: BrickFields,
  variables: Readonly<Record<string, BrickVariableValue>>,
  changed: string
): Record<string, BrickVariableValue> {
  const inputs = Object.values(definitions)
  const worked = brickFollowers(inputs, changed)
  if (!Object.hasOwn(variables, changed)) worked.add(changed)
  return brickAnswers(inputs, variables, worked)
}

const PUBLISHED_JAVA_EMBERS = ["11", "17", "21", "25"] as const

function supportedJavaVersions(definition: BrickInput): Array<string> {
  if (!isTextBrickField(definition)) return []
  const candidates = definition.options?.length
    ? definition.options.map(String)
    : PUBLISHED_JAVA_EMBERS
  return candidates.filter((version) =>
    stringVariableAllows(definition, version)
  )
}

export function javaVersionSelectOptions(
  definition: BrickInput,
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

export function stringVariableAllows(
  definition: BrickInput,
  value: string
): boolean {
  return (
    isTextBrickField(definition) && brickInputProblem(definition, value) === null
  )
}

export function defaultBrickInstanceName(brick: Brick): string {
  const brickName = brick.metadata.name
    .slice(0, RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH)
    .trimEnd()
  return `${brickName}${BRICK_INSTANCE_NAME_SUFFIX}`
}

function interpolateBrickTemplate(
  template: string,
  values: Readonly<Record<string, BrickVariableValue>>,
  brick?: { id: string; name?: string }
): string {
  // What isn't answered yet stays as it is written.
  return fillBrickTemplate(template, (name) => {
    if (name === "brick.id") return brick?.id
    if (name === "brick.name") return brick?.name
    if (!Object.hasOwn(values, name)) return undefined
    const value = values[name]
    return value === undefined ? undefined : String(value)
  })
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
