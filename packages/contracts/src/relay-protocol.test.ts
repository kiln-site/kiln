import { Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  RelayAuthReadySchema,
  RelayBrowserCapabilitySchema,
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

  it("keeps capability version independent from browser subprotocol versions", () => {
    const capability = Schema.decodeUnknownSync(RelayBrowserCapabilitySchema)({
      actions: ["instance.console.read"],
      audience: "relay-a",
      authorizationRevision: 12,
      capabilityId: "capability-a",
      expiresAt: 60_000,
      instanceId: "instance-a",
      issuedAt: 1,
      issuer: "hearth-a",
      issuerGeneration: 3,
      keyThumbprint: "thumbprint-a",
      loginSessionId: "session-a",
      operation: "console",
      origin: "https://hearth.test",
      path: null,
      subject: "user-a",
      version: 2,
    })
    expect(capability.version).toBe(2)
    if (capability.version === 2) {
      expect(capability.operation).toBe("console")
      expect(capability.authorizationRevision).toBe(12)
    }
  })
})
