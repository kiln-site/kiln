import { describe, expect, it } from "vite-plus/test"

import { githubSyncTargetAccess } from "./github-sync-targets"

const relayId = "O7QzfyBsuuzJ3ls2SryRTGi5KHhvDba8uH3d_Na3KCs"
const otherRelayId = "Xx9QzfyBsuuzJ3ls2SryRTGi5KHhvDba8uH3d_Na3K"

// A Relay picks a file root by the shape of its ID, so a target whose ID
// doesn't fit its kind would be authorized as one thing and written as
// another.
describe("GitHub sync targets", () => {
  it("refuses a game server or app named by a Relay's ID", () => {
    expect(
      githubSyncTargetAccess({ id: relayId, kind: "server", relayId })
    ).toBeNull()
    expect(
      githubSyncTargetAccess({ id: relayId, kind: "app", relayId })
    ).toBeNull()
  })

  it("writes a Relay's host files only under its own Relay", () => {
    expect(
      githubSyncTargetAccess({ id: otherRelayId, kind: "relay", relayId })
    ).toBeNull()
    expect(
      githubSyncTargetAccess({ id: relayId, kind: "relay", relayId })
    ).toMatchObject({ fileRootId: relayId, write: "relay.files.write" })
  })
})
