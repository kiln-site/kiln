import { Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  RelayAuthReadySchema,
  relayBrowserCapabilityV2Feature,
  relayBrowserLeaseRenewalV1Feature,
  relayControlProtocol,
  relayFileRequestReplayV1Feature,
} from "./relay-protocol.js"

const LegacyRelayAuthReadySchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  clientId: Schema.String,
  protocol: Schema.Literal(relayControlProtocol),
  relayBuild: Schema.String,
  role: Schema.Literals(["full_access", "read_only", "custom"]),
  type: Schema.Literal("auth.ready"),
  v: Schema.Literal(1),
})

describe("Relay browser protocol compatibility", () => {
  it("lets a pre-feature ready decoder accept advertised features", () => {
    const ready = {
      actions: ["relay.read"],
      browserIssuerGeneration: 4,
      clientId: "hearth-a",
      features: [
        relayBrowserCapabilityV2Feature,
        relayBrowserLeaseRenewalV1Feature,
        relayFileRequestReplayV1Feature,
      ],
      protocol: relayControlProtocol,
      relayBuild: "test",
      role: "read_only" as const,
      type: "auth.ready" as const,
      v: 1 as const,
    }
    expect(
      Schema.decodeUnknownSync(RelayAuthReadySchema)(ready).features
    ).toEqual(ready.features)
    expect(
      Schema.decodeUnknownSync(RelayAuthReadySchema)(ready)
        .browserIssuerGeneration
    ).toBe(4)
    expect(
      Schema.decodeUnknownSync(LegacyRelayAuthReadySchema)(ready)
    ).not.toHaveProperty("features")
    expect(
      Schema.decodeUnknownSync(LegacyRelayAuthReadySchema)(ready)
    ).not.toHaveProperty("browserIssuerGeneration")

    for (const browserIssuerGeneration of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(RelayAuthReadySchema)({
          ...ready,
          browserIssuerGeneration,
        })
      ).toThrow()
    }
  })
})
