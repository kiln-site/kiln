import { describe, expect, it } from "vite-plus/test"

import { deterministicBrickColor } from "./brick-icon"

describe("Brick icon colors", () => {
  it("uses a stable fallback for a Brick id", () => {
    expect(deterministicBrickColor("custom-brick")).toBe(
      deterministicBrickColor("custom-brick")
    )
    expect(deterministicBrickColor("CUSTOM-BRICK")).toBe(
      deterministicBrickColor("custom-brick")
    )
  })
})
