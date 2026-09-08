import type {
  BrickRecipe,
  BrickVariableValue,
  RelayInstance,
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

// Include defaults and every variable referenced by resource templates. Omitted
// variables and Brick swaps must not bypass the independent limits permission.
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
    const resources = recipe.runtime.resources
    const referenced = [
      ...new Set(
        Array.from(
          JSON.stringify(resources).matchAll(
            /variables\.([a-z][a-z0-9_]{0,47})/gu
          ),
          (match) => match[1]
        )
      ),
    ].sort()
    return JSON.stringify([
      resources,
      referenced.map((key) => [
        key,
        Object.hasOwn(variables, key)
          ? variables[key]
          : recipe.variables[key]?.default,
      ]),
    ])
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
  const resourceVariables = new Set(
    Array.from(
      JSON.stringify([
        previous.runtime.resources,
        next.runtime.resources,
      ]).matchAll(/variables\.([a-z][a-z0-9_]{0,47})/gu),
      (match) => match[1]
    )
  )
  const keys = new Set([
    ...Object.keys(previous.variables),
    ...Object.keys(next.variables),
    ...Object.keys(previousVariables),
    ...Object.keys(nextVariables),
  ])
  for (const key of keys) {
    if (resourceVariables.has(key)) continue
    const before = Object.hasOwn(previousVariables, key)
      ? previousVariables[key]
      : previous.variables[key]?.default
    const after = Object.hasOwn(nextVariables, key)
      ? nextVariables[key]
      : next.variables[key]?.default
    if (!Object.is(before, after)) return true
  }
  return false
}
