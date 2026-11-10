import {
  brickAnswers,
  brickInputs,
  brickTemplateReferences,
  type BrickRecipe,
  type BrickVariableValue,
  type RelayInstance,
} from "@workspace/contracts"

export function startupPowerPermission(
  existing: Pick<RelayInstance, "desiredState" | "observedState">,
  input: { start: boolean; reinstall?: boolean }
):
  | "instance.power.start"
  | "instance.power.stop"
  | "instance.power.restart"
  | null {
  const running =
    existing.desiredState === "running" ||
    ["running", "starting", "stopping"].includes(existing.observedState)
  const start = input.reinstall
    ? existing.desiredState === "running"
    : input.start
  return running
    ? start
      ? "instance.power.restart"
      : "instance.power.stop"
    : start
      ? "instance.power.start"
      : null
}

// The inputs a template takes its values from.
function referenced(
  recipe: BrickRecipe,
  templates: ReadonlyArray<string>
): Array<string> {
  const declared = new Set(brickInputs(recipe).map((input) => input.key))
  return [
    ...new Set(
      templates
        .flatMap(brickTemplateReferences)
        .filter((name) => declared.has(name))
    ),
  ].sort()
}

// What of a recipe sets a server's resources, and the inputs those templates
// take their values from.
function resources(recipe: BrickRecipe): {
  inputs: Array<string>
  limits: unknown
} {
  const deploy = recipe.deploy
  return {
    inputs: referenced(recipe, [deploy?.memory ?? ""]),
    limits: [
      deploy?.memory ?? null,
      deploy && "pids" in deploy ? (deploy.pids ?? null) : null,
    ],
  }
}

// The inputs whose only use is a resource limit. One that also sets the
// image, the runtime, the environment or a port is configuration too, and
// changing it takes both permissions. These are the parts of a deployment
// that take templates (`brickDeployTemplateFields`), and a port.
function limitOnlyInputs(recipe: BrickRecipe): Set<string> {
  const deploy = recipe.deploy
  const configured = new Set(
    referenced(recipe, [
      deploy && "image" in deploy ? deploy.image : "",
      deploy && "runtime" in deploy ? (deploy.runtime ?? "") : "",
      ...Object.values(deploy?.env ?? {}),
      ...(deploy?.ports ?? []).flatMap((port) =>
        typeof port.port === "string" ? [port.port] : []
      ),
    ])
  )
  return new Set(resources(recipe).inputs.filter((key) => !configured.has(key)))
}

/**
 * The answers a recipe runs with, as its Relay works them out: what was
 * given, else what follows it, else a default. Comparing these, and not what
 * was sent, is what keeps an answer nobody sent from changing unnoticed.
 */
function answersOf(
  recipe: BrickRecipe,
  variables: Readonly<Record<string, BrickVariableValue>>
): (key: string) => BrickVariableValue | undefined {
  const inputs = brickInputs(recipe)
  const worked = brickAnswers(inputs, variables)
  return (key) =>
    inputs.some((input) => input.key === key) ? worked[key] : variables[key]
}

// Include defaults, what follows other answers, and every input referenced
// by resource templates. Omitted answers and Brick swaps must not bypass the
// independent limits permission.
export function startupResourceLimitsChanged(
  previous: BrickRecipe,
  next: BrickRecipe,
  previousVariables: Readonly<Record<string, BrickVariableValue>>,
  nextVariables: Readonly<Record<string, BrickVariableValue>>
): boolean {
  const signature = (
    recipe: BrickRecipe,
    variables: Readonly<Record<string, BrickVariableValue>>
  ) => {
    const { inputs, limits } = resources(recipe)
    const answer = answersOf(recipe, variables)
    return JSON.stringify([limits, inputs.map((key) => [key, answer(key)])])
  }
  return (
    signature(previous, previousVariables) !== signature(next, nextVariables)
  )
}

export function startupConfigurationChanged(
  previous: BrickRecipe,
  next: BrickRecipe,
  previousVariables: Readonly<Record<string, BrickVariableValue>>,
  nextVariables: Readonly<Record<string, BrickVariableValue>>
): boolean {
  // Its Relay looks the newest version up when none is sent, and may land
  // on another one.
  if (
    next.minecraft?.latestVersion &&
    !Object.hasOwn(nextVariables, "version")
  ) {
    return true
  }
  // Left to the limits check only where both recipes use it for nothing
  // else.
  const limitsBefore = limitOnlyInputs(previous)
  const limitsAfter = limitOnlyInputs(next)
  const usedBefore = new Set(brickInputs(previous).map((input) => input.key))
  const usedAfter = new Set(brickInputs(next).map((input) => input.key))
  const limitOnly = (key: string) =>
    (limitsBefore.has(key) || limitsAfter.has(key)) &&
    (limitsBefore.has(key) || !usedBefore.has(key)) &&
    (limitsAfter.has(key) || !usedAfter.has(key))
  const keys = new Set([
    ...brickInputs(previous).map((input) => input.key),
    ...brickInputs(next).map((input) => input.key),
    ...Object.keys(previousVariables),
    ...Object.keys(nextVariables),
  ])
  const before = answersOf(previous, previousVariables)
  const after = answersOf(next, nextVariables)
  for (const key of keys) {
    if (limitOnly(key)) continue
    if (!Object.is(before(key), after(key))) return true
  }
  return false
}
