import { Effect, Exit, Queue, Scope } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createRelayBrowserSocketInbox,
  maintainRelayBrowserLease,
  relayBrowserAuthorizationChanges,
} from "./authenticated-relay-socket"
import { notifyRelayBrowserAuthorizationChanged } from "./relay-browser-credentials"

const encodedCapability = `${btoa(JSON.stringify({ capabilityId: "cap-one" }))}.signature`

afterEach(() => {
  vi.restoreAllMocks()
})

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
  it("retains access-change wakeups without active credentials and releases its subscription", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* relayBrowserAuthorizationChanges(
            "denied-relay",
            "denied-instance"
          )
          notifyRelayBrowserAuthorizationChanged()
          yield* Queue.take(changes)
        })
      )
    )
    expect(() => notifyRelayBrowserAuthorizationChanged()).not.toThrow()
  })

  it("uses a browser-valid close code when a bounded consumer overflows", async () => {
    const close = vi.fn((code: number) => {
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          "Invalid browser close code",
          "InvalidAccessError"
        )
      }
    })
    const socket = Object.assign(new EventTarget(), { close })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createRelayBrowserSocketInbox(
            socket as unknown as WebSocket,
            "resources"
          )
          for (let index = 0; index < 65; index += 1) {
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ type: "auth.ready" }),
              })
            )
          }
          expect(close).toHaveBeenCalledOnce()
          expect(close).toHaveBeenCalledWith(
            4013,
            "resources consumer is too slow"
          )
        })
      )
    )
  })

  it("reconnects instead of retrying a nonce after an ambiguous sent renewal", async () => {
    const { called: closed, mock: close } = calledOnce((code: number) => {
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          "Invalid browser close code",
          "InvalidAccessError"
        )
      }
    })
    const send = vi.fn()
    const issue = vi.fn().mockResolvedValue({
      capability: encodedCapability,
      expiresAt: Date.now() + 30_000,
      version: 2,
    })
    vi.spyOn(crypto.subtle, "sign").mockResolvedValue(
      new Uint8Array([1]).buffer
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* maintainRelayBrowserLease(
            {
              socket: { send, close },
              inbox: {
                waitFor: vi
                  .fn()
                  .mockRejectedValue(new Error("Acknowledgement timed out")),
              },
            } as never,
            {
              sessionId: "session",
              expiresAt: Date.now() + 60_000,
              renewalNonce: "nonce",
              renewalNonceExpiresAt: Date.now() + 60_000,
            },
            {
              channel: "resources",
              credentials: { keys: { privateKey: {} } } as never,
              relayId: "relay",
              write: false,
              issue,
            }
          )
          lease.renewNow()
          yield* Effect.promise(() => closed)
          expect(close).toHaveBeenCalledWith(
            4012,
            "Relay lease renewal needs reconnect"
          )
          lease.renewNow()
          yield* Effect.yieldNow
          expect(issue).toHaveBeenCalledOnce()
          expect(send).toHaveBeenCalledOnce()
        })
      )
    )
  })

  it("does not deliver a late renewal acknowledgement to the data stream", async () => {
    const socket = new EventTarget()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createRelayBrowserSocketInbox(
            socket as WebSocket,
            "resources"
          )
          const controller = new AbortController()
          const response = inbox.waitFor("auth.renewed", controller.signal)
          const rejected = expect(response).rejects.toThrow("cancelled")
          controller.abort()
          yield* Effect.promise(() => rejected)
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "auth.renewed" }),
            })
          )
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "resource",
                sequence: 1,
                history: [],
              }),
            })
          )
          expect(yield* inbox.take).toEqual({
            type: "resource",
            sequence: 1,
            history: [],
          })
        })
      )
    )
  })

  it("interrupts issuance when the owning scope closes, without a late proof or send", async () => {
    let resolveIssued!: (value: {
      capability: string
      expiresAt: number
      version: 2
    }) => void
    const issued = new Promise<{
      capability: string
      expiresAt: number
      version: 2
    }>((resolve) => {
      resolveIssued = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const send = vi.fn()
    const sign = vi.spyOn(crypto.subtle, "sign")
    const scope = await Effect.runPromise(Scope.make())
    const lease = await Effect.runPromise(
      maintainRelayBrowserLease(
        { socket: { send }, inbox: {} } as never,
        {
          sessionId: "session",
          expiresAt: Date.now() + 60_000,
          renewalNonce: "nonce",
          renewalNonceExpiresAt: Date.now() + 60_000,
        },
        {
          channel: "console",
          credentials: {} as never,
          relayId: "relay",
          write: true,
          issue: () => {
            markStarted()
            return issued
          },
        }
      ).pipe(Scope.provide(scope))
    )
    lease.renewNow()
    await started
    await Effect.runPromise(Scope.close(scope, Exit.void))
    resolveIssued({
      capability: encodedCapability,
      expiresAt: Date.now() + 30_000,
      version: 2,
    })
    await issued
    await Promise.resolve()
    expect(sign).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("coalesces resource samples without dropping authentication or initial history", async () => {
    const socket = new EventTarget()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createRelayBrowserSocketInbox(
            socket as WebSocket,
            "resources"
          )
          for (const data of [
            { type: "auth.ready" },
            {
              type: "resource",
              sequence: 1,
              history: [{ sampledAt: "initial" }],
            },
            { type: "resource", sequence: 2, history: [] },
          ])
            socket.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(data) })
            )
          expect(yield* inbox.take).toEqual({ type: "auth.ready" })
          expect(yield* inbox.take).toEqual({
            type: "resource",
            sequence: 2,
            history: [{ sampledAt: "initial" }],
          })
        })
      )
    )
  })

  it("renews in place and consumes the priority acknowledgement", async () => {
    const { called: sent, mock: send } = calledOnce()
    const waitFor = vi.fn().mockResolvedValue({
      expiresAt: Date.now() + 120_000,
      renewalNonce: "nonce-two",
      renewalNonceExpiresAt: Date.now() + 30_000,
      type: "auth.renewed",
      v: 1,
    })
    vi.spyOn(crypto.subtle, "sign").mockResolvedValue(
      new Uint8Array([1, 2, 3]).buffer
    )
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
          lease.renewNow()
          yield* Effect.promise(() => sent)
        })
      )
    )

    expect(issue).toHaveBeenCalledOnce()
    expect(waitFor).toHaveBeenCalledWith(
      "auth.renewed",
      expect.any(AbortSignal)
    )
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      capability: encodedCapability,
      type: "auth.renew",
      v: 1,
    })
  })

  it("closes immediately when Hearth denies a renewal", async () => {
    const { called: closed, mock: close } = calledOnce()
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
