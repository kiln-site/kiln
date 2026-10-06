import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("@sentry/tanstackstart-react", () => ({
  captureException: vi.fn(),
}))

import { removeRelayThenCleanup } from "./relay-removal"

describe("Relay removal orchestration", () => {
  it("does not start cleanup when deleting the Relay fails", async () => {
    const calls: Array<string> = []
    const deletionError = new Error("Relay deletion failed")

    await expect(
      removeRelayThenCleanup(
        {
          forgetBackups: true,
          relayId: "relay-one",
          removeVanityDomains: true,
        },
        {
          deleteRelay: async () => {
            calls.push("delete")
            throw deletionError
          },
          forgetBackups: async () => {
            calls.push("backups")
            return 1
          },
          removeManagedDomains: async () => {
            calls.push("domains")
            return 1
          },
        }
      )
    ).rejects.toBe(deletionError)

    expect(calls).toEqual(["delete"])
  })

  it("keeps deletion successful when later cleanup fails", async () => {
    const calls: Array<string> = []
    const domainError = new Error("Cloudflare unavailable")

    const result = await removeRelayThenCleanup(
      {
        forgetBackups: true,
        relayId: "relay-one",
        removeVanityDomains: true,
      },
      {
        deleteRelay: async () => {
          calls.push("delete")
        },
        forgetBackups: async () => {
          calls.push("backups")
          return 2
        },
        removeManagedDomains: async () => {
          calls.push("domains")
          throw domainError
        },
      }
    )

    expect(calls[0]).toBe("delete")
    expect(calls.slice(1).sort()).toEqual(["backups", "domains"])
    expect(result).toEqual({
      cleanupFailures: ["domains"],
      forgottenBackups: 2,
      removed: true,
      removedVanityDomains: 0,
    })
  })
})
