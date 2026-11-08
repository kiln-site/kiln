import { describe, expect, it } from "vite-plus/test"

import { relayFileRootId } from "@workspace/contracts"

import { githubSyncTargetAccess } from "./github-sync-targets"

const relayId = "1".repeat(12)
const otherRelayId = "2".repeat(12)

// A target whose ID doesn't fit its kind would be authorized as one thing and
// written as another.
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
    ).toMatchObject({
      fileRootId: relayFileRootId(relayId),
      write: "relay.files.write",
    })
  })
})
