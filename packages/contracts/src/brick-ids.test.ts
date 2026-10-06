import { describe, expect, it } from "vite-plus/test"

import { brickIdSchema } from "./index"

describe("Brick ids", () => {
  it("keeps the existing 64-character interoperability ceiling", () => {
    expect(brickIdSchema.safeParse("a".repeat(64)).success).toBe(true)
    expect(brickIdSchema.safeParse("a".repeat(65)).success).toBe(false)
  })
})
