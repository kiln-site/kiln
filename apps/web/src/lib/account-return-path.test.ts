import { describe, expect, it } from "vite-plus/test"
import { accountReturnPath } from "./account-return-path"

describe("account return path", () => {
  it("preserves the intended invitation through verification", () => {
    expect(accountReturnPath("/invite?id=example#details")).toBe(
      "/invite?id=example#details"
    )
  })
  it("rejects external and browser-normalized external redirects", () => {
    for (const input of [
      "https://outside.test",
      "//outside.test",
      "/\\outside.test",
      "javascript:alert(1)",
      undefined,
    ]) {
      expect(accountReturnPath(input)).toBe("/")
    }
  })
})
