import { describe, expect, it } from "vite-plus/test"

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
})
