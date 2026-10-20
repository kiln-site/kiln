import { describe, expect, it, vi } from "vite-plus/test"

import {
  claimPreparedProvisioning,
  provisioningInstanceId,
} from "@/lib/provisioning.server"

describe("prepared provisioning", () => {
  it("uses the same Relay instance id when an unchanged request is retried", () => {
    const key = "55000000-0000-4000-8000-000000000001"

    expect(provisioningInstanceId(key)).toBe(
      "5500000000004000800000000000000155000000"
    )
  })

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

  it("drops ownership only after Relay confirms cancellation", async () => {
    const unregister = vi.fn(async () => undefined)

    await expect(
      claimPreparedProvisioning({
        cancel: async () => true,
        unconfirmed: "Retry it.",
        claim: async () => {
          throw new Error("Relay rejected the claim")
        },
        unregister,
      })
    ).rejects.toThrow("Relay rejected the claim")
    expect(unregister).toHaveBeenCalled()
  })
})
