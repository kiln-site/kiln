import { describe, expect, it } from "vite-plus/test"

import {
  brickIdSchema,
  MAXIMUM_BRICK_ID_LENGTH,
  normalizeImportedBrickRecipeId,
} from "./index"

describe("Brick ids", () => {
  it("enforces a 20-character maximum", () => {
    expect(
      brickIdSchema.safeParse("a".repeat(MAXIMUM_BRICK_ID_LENGTH)).success
    ).toBe(true)
    expect(
      brickIdSchema.safeParse("a".repeat(MAXIMUM_BRICK_ID_LENGTH + 1))
        .success
    ).toBe(false)
  })

  it("keeps the first 20 characters of an imported Brick id", () => {
    const value = {
      format: "kiln.brick/v1",
      metadata: { id: "abcdefghijklmnopqrst-extra" },
    }

    expect(normalizeImportedBrickRecipeId(value)).toEqual({
      idWasTruncated: true,
      value: {
        ...value,
        metadata: { id: "abcdefghijklmnopqrst" },
      },
    })
    expect(value.metadata.id).toBe("abcdefghijklmnopqrst-extra")
  })
})
