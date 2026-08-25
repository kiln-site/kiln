import { builtinTailscaleBrick } from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import {
  brickRecipeDefinition,
  claimPreparedProvisioning,
  compensatePreparedProvisioning,
  hearthCreateInstanceInputSchema,
  hearthUpdateInstanceStartupInputSchema,
  isBrickSourceChange,
  parseImportedBrickFromRelay,
  provisioningInstanceId,
} from "@/server/bricks"

const { source, ...recipeDefinition } = builtinTailscaleBrick

describe("Hearth Brick mutation inputs", () => {
  it("uses the same Relay instance id when an unchanged request is retried", () => {
    const key = "55000000-0000-4000-8000-000000000001"

    expect(provisioningInstanceId(key)).toBe(
      "5500000000004000800000000000000155000000"
    )
  })

  it("cancels a prepared job before removing its reserved owner", async () => {
    const unregister = vi.fn(async () => undefined)

    await Effect.runPromise(
      compensatePreparedProvisioning(async () => true, unregister)
    )

    expect(unregister).toHaveBeenCalledOnce()
  })

  it("keeps ownership when a failed claim is already running", async () => {
    const unregister = vi.fn(async () => undefined)

    await expect(
      claimPreparedProvisioning({
        cancel: async () => false,
        claim: async () => {
          throw new Error("Claim response timed out")
        },
        unregister,
      })
    ).resolves.toBeUndefined()
    expect(unregister).not.toHaveBeenCalled()
  })

  it("drops ownership only after Relay confirms cancellation", async () => {
    const unregister = vi.fn(async () => undefined)

    await expect(
      claimPreparedProvisioning({
        cancel: async () => true,
        claim: async () => {
          throw new Error("Relay rejected the claim")
        },
        unregister,
      })
    ).rejects.toThrow("Relay rejected the claim")
    expect(unregister).toHaveBeenCalledOnce()
  })

  it("keeps same-source Startup saves pinned to the stored snapshot", () => {
    expect(isBrickSourceChange(source, source)).toBe(false)
    expect(isBrickSourceChange(source, undefined)).toBe(false)
    expect(isBrickSourceChange(source, "https://example.com/other.yml")).toBe(
      true
    )
  })

  it("keeps cached icon markup out of Relay recipe definitions", () => {
    const definition = brickRecipeDefinition({
      ...builtinTailscaleBrick,
      iconSvg: '<svg viewBox="0 0 24 24"></svg>',
    })

    expect(definition).not.toHaveProperty("iconSvg")
    expect(definition.metadata.id).toBe(builtinTailscaleBrick.metadata.id)
  })

  it("preserves ids beyond the recommendation returned by a Relay", () => {
    const imported = parseImportedBrickFromRelay({
      ...builtinTailscaleBrick,
      metadata: {
        ...builtinTailscaleBrick.metadata,
        id: "abcdefghijklmnopqrstuvwxyz",
      },
    })

    expect(imported.brick.metadata.id).toBe("abcdefghijklmnopqrstuvwxyz")
    expect(imported.brickIdExceedsRecommendation).toBe(true)
  })

  it("rejects browser-supplied recipes during server creation", () => {
    const parsed = hearthCreateInstanceInputSchema.safeParse({
      idempotencyKey: "55000000-0000-4000-8000-000000000001",
      name: "Example",
      recipe: source,
      recipeDefinition,
      relayId: "a".repeat(43),
      variables: {},
    })

    expect(parsed.success).toBe(false)
  })

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
            message: "Brick definitions are resolved by Hearth",
            path: ["recipeDefinition"],
          }),
        ])
      )
    }
  })
})
