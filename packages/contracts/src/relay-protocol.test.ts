import { Option, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  RelayControlServerMessageSchema,
  relayControlProtocol,
} from "./relay-protocol.js"

// Decode exactly as Hearth does what a Relay sends.
const decodeServerMessage = Schema.decodeUnknownOption(
  RelayControlServerMessageSchema
)

describe("Relay control protocol", () => {
  // An outdated Relay must still connect far enough for Hearth to update it.
  it("accepts an outdated Relay's handshake without later optional fields", () => {
    const outdatedReady = {
      actions: ["relay.read"],
      clientId: "hearth-a",
      protocol: relayControlProtocol,
      relayBuild: "test",
      role: "read_only",
      type: "auth.ready",
      v: 1,
    } as const

    expect(decodeServerMessage(outdatedReady)).toEqual(
      Option.some(outdatedReady)
    )
  })
})
