import { describe, expect, it } from "vite-plus/test"

import {
  isMinecraftUsername,
  minecraftHeadUrl,
  minecraftUsernameKey,
} from "./minecraft-profile"

describe("Minecraft profile helpers", () => {
  it("validates the username shape before making an external request", () => {
    expect(isMinecraftUsername("Notch")).toBe(true)
    expect(isMinecraftUsername("Kiln Developer")).toBe(false)
    expect(isMinecraftUsername("ab")).toBe(false)
  })

  it("builds a sized MCHeads avatar URL from a profile id", () => {
    expect(minecraftHeadUrl("069a79f444e94726a5befca90e38aaf5")).toBe(
      "https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/32.png"
    )
  })

  it("canonicalizes usernames for shared profile caches", () => {
    expect(minecraftUsernameKey(" Notch ")).toBe("notch")
  })
})
