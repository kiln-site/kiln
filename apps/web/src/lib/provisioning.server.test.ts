import { describe, expect, it, vi } from "vite-plus/test"

import { claimPreparedProvisioning } from "@/lib/provisioning.server"

describe("prepared provisioning", () => {
  it("keeps ownership when a failed claim is already running", async () => {
    const unregister = vi.fn(async () => undefined)

    await expect(
      claimPreparedProvisioning({
        cancel: async () => false,
        unconfirmed: "Retry it.",
        claim: async () => {
          throw new Error("Claim response timed out")
        },
        unregister,
      })
    ).resolves.toBeUndefined()
    expect(unregister).not.toHaveBeenCalled()
  })
})
