import { describe, expect, it } from "vite-plus/test"

import { validateBrickIconSvg } from "./brick-icons"

describe("Brick icon SVGs", () => {
  it.each([
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 24 24"><image href="https://example.com/a.png"/></svg>',
    '<svg viewBox="0 0 24 24"><path onclick="alert(1)"/></svg>',
    '<svg viewBox="0 0 24 24"><path fill="url(#paint)"/></svg>',
  ])("rejects active or externally resolved SVG content", (svg: string) => {
    expect(() => validateBrickIconSvg(svg)).toThrow(
      "unsupported active content"
    )
  })
})
