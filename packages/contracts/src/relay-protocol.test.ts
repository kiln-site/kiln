import { Option, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  RelayAuthReadySchema,
  RelayControlClientMessageSchema,
  RelayControlServerMessageSchema,
  relayBrowserCapabilityV2Feature,
  relayControlProtocol,
} from "./relay-protocol.js"

// Decode exactly as Hearth (server messages) and Relay (client messages) do.
const decodeServerMessage = Schema.decodeUnknownOption(
  RelayControlServerMessageSchema
)
const decodeClientMessage = Schema.decodeUnknownOption(
  RelayControlClientMessageSchema
)

const authReady = {
  actions: ["relay.read"],
  browserIssuerGeneration: 4,
  clientId: "hearth-a",
  features: [relayBrowserCapabilityV2Feature],
  protocol: relayControlProtocol,
  relayBuild: "test",
  role: "read_only",
  type: "auth.ready",
  v: 1,
} as const
const request = {
  deadline: 1_000,
  id: "request-1",
  operation: "relay.snapshot",
  payload: { any: "thing" },
  subject: "user-1",
  timeoutMs: 500,
  type: "request",
  v: 1,
} as const
const cancel = { id: "c", replyTo: "request-1", type: "cancel", v: 1 } as const
const response = {
  id: "r",
  payload: null,
  replyTo: "request-1",
  type: "response",
  v: 1,
} as const
const error = {
  code: "failed",
  id: "e",
  message: "Failed",
  replyTo: null,
  retryable: false,
  type: "error",
  v: 1,
} as const

const serverMessages = [
  {
    expiresAt: 1,
    nonce: "n",
    relayId: "relay",
    sessionId: "s",
    signature: "sig",
    type: "auth.challenge",
    v: 1,
  },
  authReady,
  cancel,
  response,
  error,
  {
    event: "relay.snapshot",
    id: "ev",
    payload: {},
    seq: 1,
    type: "event",
    v: 1,
  },
  request,
] as const
const clientMessages = [
  {
    clientId: "hearth-a",
    features: [relayBrowserCapabilityV2Feature],
    signature: "sig",
    type: "auth.response",
    v: 1,
  },
  request,
  cancel,
  response,
  error,
] as const

describe("Relay control protocol compatibility", () => {
  it("decodes every message from a newer peer that adds fields", () => {
    const newer = { addedByNewerPeer: { nested: true }, futureFlag: 1 }
    for (const message of serverMessages) {
      expect(
        decodeServerMessage({ ...message, ...newer }),
        message.type
      ).toEqual(Option.some(message))
    }
    for (const message of clientMessages) {
      expect(
        decodeClientMessage({ ...message, ...newer }),
        message.type
      ).toEqual(Option.some(message))
    }
  })

  it("decodes messages from an older peer without later optional fields", () => {
    const {
      browserIssuerGeneration: _generation,
      features: _features,
      ...legacyReady
    } = authReady
    const {
      subject: _subject,
      timeoutMs: _timeoutMs,
      ...legacyRequest
    } = request
    const { features: _responseFeatures, ...legacyAuthResponse } =
      clientMessages[0]

    expect(decodeServerMessage(legacyReady)).toEqual(Option.some(legacyReady))
    expect(decodeServerMessage(legacyRequest)).toEqual(
      Option.some(legacyRequest)
    )
    expect(decodeClientMessage(legacyRequest)).toEqual(
      Option.some(legacyRequest)
    )
    expect(decodeClientMessage(legacyAuthResponse)).toEqual(
      Option.some(legacyAuthResponse)
    )
  })

  it("rejects browser issuer generations that cannot order revocations", () => {
    for (const browserIssuerGeneration of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(RelayAuthReadySchema)({
            ...authReady,
            browserIssuerGeneration,
          })
        )
      ).toBe(true)
    }
  })
})
