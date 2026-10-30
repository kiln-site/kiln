import { describe, expect, it } from "vite-plus/test"

import { validateUploadedIcon } from "@/lib/icon-validation"

describe("validateUploadedIcon", () => {
  it("refuses anything but WebP or PNG, whatever it's named", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )
    expect(() => validateUploadedIcon(svg)).toThrow()
    const html = new TextEncoder().encode("<!doctype html><p>hi</p>")
    expect(() => validateUploadedIcon(html)).toThrow()
    expect(() => validateUploadedIcon(new Uint8Array())).toThrow()
  })
})
