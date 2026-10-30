import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

import { maintainRelayBrowserLease } from "./authenticated-relay-socket"

/** A mock implementation plus a promise that settles on its first call. */
function calledOnce<TArgs extends Array<unknown>>(
  implementation: (...args: TArgs) => void = () => undefined
) {
  let markCalled: () => void = () => undefined
  const called = new Promise<void>((resolve) => {
    markCalled = resolve
  })
  const mock = vi.fn((...args: TArgs) => {
    implementation(...args)
    markCalled()
  })
  return { called, mock }
}

describe("Relay browser lease renewal", () => {
  it("closes immediately when Hearth denies a renewal", async () => {
    const { called: closed, mock: close } = calledOnce()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* maintainRelayBrowserLease(
            {
              challenge: {
                earlyMessages: false,
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
          lease.renewNow()
          yield* Effect.promise(() => closed)
        })
      )
    )

    expect(close).toHaveBeenCalledWith(
      4403,
      "Relay browser authorization changed"
    )
  })
})
