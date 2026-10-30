import { builtinTailscaleBrick } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  hearthUpdateInstanceStartupInputSchema,
  startupPowerPermission,
  startupResourceLimitsChanged,
  startupConfigurationChanged,
} from "@/server/bricks"

const { source, ...recipeDefinition } = builtinTailscaleBrick

describe("Hearth Brick mutation inputs", () => {
  it("rejects browser-supplied recipes during startup updates", () => {
    const parsed = hearthUpdateInstanceStartupInputSchema.safeParse({
      instanceId: "b".repeat(40),
      recipe: source,
      recipeDefinition,
      relayId: "a".repeat(43),
      variables: {},
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["recipeDefinition"],
          }),
        ])
      )
    }
  })
})

describe("Startup granular authority", () => {
  it("requires restart for running rebuilds, including reinstalls, and no power for stopped edits", () => {
    expect(
      startupPowerPermission(
        { desiredState: "running", observedState: "running" },
        { start: true }
      )
    ).toBe("instance.power.restart")
    expect(
      startupPowerPermission(
        { desiredState: "running", observedState: "running" },
        { start: false, reinstall: true }
      )
    ).toBe("instance.power.restart")
    expect(
      startupPowerPermission(
        { desiredState: "running", observedState: "running" },
        { start: false }
      )
    ).toBe("instance.power.stop")
    expect(
      startupPowerPermission(
        { desiredState: "stopped", observedState: "stopped" },
        { start: false }
      )
    ).toBeNull()
    expect(
      startupPowerPermission(
        { desiredState: "stopped", observedState: "stopped" },
        { start: true }
      )
    ).toBe("instance.power.start")
  })
  it("detects changed resource variables, omitted defaults, and recipe limits without treating unrelated variables as limits", () => {
    const recipe = {
      ...recipeDefinition,
      variables: {
        memory: {
          type: "string" as const,
          sensitive: false,
          label: "Memory",
          description: "Memory",
          default: "1g",
          required: false,
        },
      },
      runtime: {
        ...recipeDefinition.runtime,
        resources: {
          ...recipeDefinition.runtime.resources,
          memory: "{{ variables.memory }}",
        },
      },
    }
    expect(
      startupConfigurationChanged(
        recipe,
        recipe,
        { memory: "2g" },
        { memory: "3g" }
      )
    ).toBe(false)
    expect(
      startupConfigurationChanged(
        recipe,
        recipe,
        { memory: "2g", version: "old" },
        { memory: "3g", version: "new" }
      )
    ).toBe(true)
    expect(
      startupConfigurationChanged(
        recipe,
        recipe,
        { memory: "2g", password: "secret" },
        { memory: "3g" }
      )
    ).toBe(true)
    expect(
      startupResourceLimitsChanged(
        recipe,
        recipe,
        { memory: "2g" },
        { memory: "3g" }
      )
    ).toBe(true)
    expect(
      startupResourceLimitsChanged(recipe, recipe, { memory: "2g" }, {})
    ).toBe(true)
    expect(
      startupResourceLimitsChanged(
        recipe,
        recipe,
        { memory: "1g", other: "old" },
        { other: "new" }
      )
    ).toBe(false)
    expect(
      startupResourceLimitsChanged(
        recipe,
        {
          ...recipe,
          runtime: {
            ...recipe.runtime,
            resources: { ...recipe.runtime.resources, memory: "4g" },
          },
        },
        {},
        {}
      )
    ).toBe(true)
  })
})
