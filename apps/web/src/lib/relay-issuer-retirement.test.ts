import { describe, expect, it, vi } from "vite-plus/test"

import { requireRelayIssuerRetirement } from "./relay-issuer-retirement"

describe("Relay issuer retirement", () => {
  it("requires a live v2 Relay to persist the generation before deletion", async () => {
    const revise = vi.fn().mockResolvedValue(true)

    await requireRelayIssuerRetirement({
      minimumGeneration: 4,
      revise,
      supportsRevisionDelivery: true,
    })

    expect(revise).toHaveBeenCalledWith(4)
  })

  it("blocks hard deletion when a live v2 Relay does not acknowledge", async () => {
    await expect(
      requireRelayIssuerRetirement({
        minimumGeneration: 5,
        revise: vi.fn().mockResolvedValue(false),
        supportsRevisionDelivery: true,
      })
    ).rejects.toThrow("was paused and was not deleted")
  })

  it("allows an offline or transitional Relay to fall back to lease expiry", async () => {
    const revise = vi.fn().mockResolvedValue(false)

    await requireRelayIssuerRetirement({
      minimumGeneration: 2,
      revise,
      supportsRevisionDelivery: false,
    })

    expect(revise).not.toHaveBeenCalled()
  })
})
