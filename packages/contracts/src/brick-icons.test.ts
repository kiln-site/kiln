import { describe, expect, it } from "vite-plus/test"

import { validateBrickIconSvg } from "./brick-icons"

describe("Brick icon SVGs", () => {
  it("accepts a passive square SVG", () => {
    expect(
      validateBrickIconSvg(
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h20v20H2z"/></svg>'
      )
    ).toContain('viewBox="0 0 24 24"')
  })

  it("rejects non-square artwork", () => {
    expect(() =>
      validateBrickIconSvg(
        '<svg viewBox="0 0 24 12"><path d="M0 0h1v1"/></svg>'
      )
    ).toThrow("must be square")
  })

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
