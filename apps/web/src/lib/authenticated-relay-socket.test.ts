import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

import { maintainRelayBrowserLease } from "./authenticated-relay-socket"

const encodedCapability = `${btoa(JSON.stringify({ capabilityId: "cap-one" }))}.signature`

describe("Relay browser lease renewal", () => {
  it("renews in place and consumes the priority acknowledgement", async () => {
    const send = vi.fn()
    const waitFor = vi.fn().mockResolvedValue({
      expiresAt: Date.now() + 120_000,
      renewalNonce: "nonce-two",
      renewalNonceExpiresAt: Date.now() + 30_000,
      type: "auth.renewed",
      v: 1,
    })
    const sign = vi
      .spyOn(crypto.subtle, "sign")
      .mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    const issue = vi.fn().mockResolvedValue({
      capability: encodedCapability,
      expiresAt: Date.now() + 120_000,
      version: 2,
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* maintainRelayBrowserLease(
            {
              challenge: {
                expiresAt: Date.now() + 30_000,
                nonce: "challenge",
                sessionId: "session-one",
              },
              inbox: { waitFor } as never,
              socket: {
                close: vi.fn(),
                protocol: "kiln.relay.browser.v1",
                send,
              } as never,
            },
            {
              expiresAt: Date.now() + 120_000,
              instanceId: "instance-one",
              renewalNonce: "nonce-one",
              renewalNonceExpiresAt: Date.now() + 30_000,
              sessionId: "session-one",
              type: "auth.ready",
              v: 1,
            },
            {
              channel: "resources",
              credentials: {
                keys: { privateKey: {} as CryptoKey } as CryptoKeyPair,
                publicKeyJwk: {
                  crv: "P-256",
                  kty: "EC",
                  x: "x",
                  y: "y",
                },
              },
              issue,
              relayId: "relay-one",
              write: false,
            }
          )
          yield* Effect.promise(() => lease.renewNow())
        })
      )
    )

    expect(issue).toHaveBeenCalledOnce()
    expect(waitFor).toHaveBeenCalledWith("auth.renewed")
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      capability: encodedCapability,
      type: "auth.renew",
      v: 1,
    })
    sign.mockRestore()
  })

  it("closes immediately when Hearth denies a renewal", async () => {
    const close = vi.fn()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* maintainRelayBrowserLease(
            {
              challenge: {
                expiresAt: Date.now() + 30_000,
                nonce: "challenge",
                sessionId: "session-one",
              },
              inbox: {} as never,
              socket: { close, protocol: "kiln.relay.browser.v1" } as never,
            },
            {
              expiresAt: Date.now() + 120_000,
              instanceId: "instance-one",
              renewalNonce: "nonce-one",
              renewalNonceExpiresAt: Date.now() + 30_000,
              sessionId: "session-one",
              type: "auth.ready",
              v: 1,
            },
            {
              channel: "console",
              credentials: {
                keys: { privateKey: {} as CryptoKey } as CryptoKeyPair,
                publicKeyJwk: {
                  crv: "P-256",
                  kty: "EC",
                  x: "x",
                  y: "y",
                },
              },
              issue: () =>
                Promise.reject(
                  new Error("Your session is no longer authorized")
                ),
              relayId: "relay-one",
              write: true,
            }
          )
          yield* Effect.promise(() => lease.renewNow())
        })
      )
    )

    expect(close).toHaveBeenCalledWith(
      4403,
      "Relay browser authorization changed"
    )
  })
})
