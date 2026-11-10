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
      instanceId: "b".repeat(12),
      recipe: source,
      recipeDefinition,
      relayId: "a".repeat(12),
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
  it("requires restart for running rebuilds, and no power for stopped edits", () => {
    expect(
      startupPowerPermission(
        { desiredState: "running", observedState: "running" },
        { start: true }
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
    // Its memory limit is one input's answer, as a recipe converted from
    // kiln.brick/v1 has it.
    const recipe = {
      ...recipeDefinition,
      inputs: [
        {
          key: "memory",
          label: "Memory",
          type: "text" as const,
          optional: true,
          default: "1g",
        },
      ],
      deploy: { ...recipeDefinition.deploy!, memory: "{{ memory }}" },
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
        { ...recipe, deploy: { ...recipe.deploy, memory: "4g" } },
        {},
        {}
      )
    ).toBe(true)
  })

  // An answer that follows another changes with it, sent or not. Changing
  // only the memory here also changes the image, which takes configuration
  // authority that a limits grant doesn't carry.
  it("counts an answer nobody sent that follows one that was", () => {
    const recipe = {
      ...recipeDefinition,
      inputs: [
        {
          key: "memory",
          label: "Memory",
          type: "text" as const,
          default: "2G",
        },
        {
          key: "tag",
          label: "Tag",
          type: "select" as const,
          options: ["small", "large"],
          default: "small",
          suggest: [{ when: "memory", matches: "^4G$", value: "large" }],
        },
      ],
      deploy: {
        ...recipeDefinition.deploy!,
        type: "image" as const,
        image: "example/server:{{ tag }}",
        memory: "{{ memory }}",
      },
    }
    const existing = { memory: "2G", tag: "small" }
    expect(
      startupConfigurationChanged(recipe, recipe, existing, { memory: "4G" })
    ).toBe(true)
    expect(
      startupResourceLimitsChanged(recipe, recipe, existing, { memory: "4G" })
    ).toBe(true)
    // Sent as it was, the tag stands, and only the limit changes.
    expect(
      startupConfigurationChanged(recipe, recipe, existing, {
        memory: "4G",
        tag: "small",
      })
    ).toBe(false)
    // Nothing sent and nothing following: nothing changed.
    expect(startupConfigurationChanged(recipe, recipe, existing, {})).toBe(
      false
    )
  })

  // An answer that sets the memory limit is left to the limits permission
  // only while that is all it sets.
  it("counts an answer that sets the limit and something else as both", () => {
    const limitOnly = {
      ...recipeDefinition,
      inputs: [
        {
          key: "memory",
          label: "Memory",
          type: "text" as const,
          default: "2G",
        },
      ],
      deploy: {
        ...recipeDefinition.deploy!,
        type: "image" as const,
        image: "example/server:latest",
        memory: "{{ memory }}",
      },
    }
    const alsoImage = {
      ...limitOnly,
      deploy: { ...limitOnly.deploy, image: "example/server:{{ memory }}" },
    }
    const alsoEnvironment = {
      ...limitOnly,
      deploy: { ...limitOnly.deploy, env: { HEAP: "{{ memory }}" } },
    }
    const changed = [{ memory: "2G" }, { memory: "4G" }] as const
    expect(startupConfigurationChanged(limitOnly, limitOnly, ...changed)).toBe(
      false
    )
    for (const recipe of [alsoImage, alsoEnvironment]) {
      expect(startupConfigurationChanged(recipe, recipe, ...changed)).toBe(true)
      expect(startupResourceLimitsChanged(recipe, recipe, ...changed)).toBe(
        true
      )
    }
    // Moving to a recipe that uses it for more is a change of configuration.
    expect(startupConfigurationChanged(limitOnly, alsoImage, ...changed)).toBe(
      true
    )
  })
})
