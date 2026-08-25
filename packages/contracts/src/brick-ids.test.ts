import { describe, expect, it } from "vite-plus/test"

import {
  brickIdExceedsRecommendedLength,
  brickIdSchema,
  RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH,
} from "./index"

describe("Brick ids", () => {
  it("treats the server-name-safe length as a recommendation", () => {
    expect(
      brickIdSchema.safeParse("a".repeat(RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH))
        .success
    ).toBe(true)
    expect(
      brickIdSchema.safeParse(
        "a".repeat(RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH + 1)
      ).success
    ).toBe(true)
    expect(
      brickIdExceedsRecommendedLength(
        "a".repeat(RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH)
      )
    ).toBe(false)
    expect(
      brickIdExceedsRecommendedLength(
        "a".repeat(RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH + 1)
      )
    ).toBe(true)
  })

  it("keeps the existing 64-character interoperability ceiling", () => {
    expect(brickIdSchema.safeParse("a".repeat(64)).success).toBe(true)
    expect(brickIdSchema.safeParse("a".repeat(65)).success).toBe(false)
  })
})
