import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

const capability = vi.hoisted(() => ({ issue: vi.fn() }))

vi.mock("@/server/relay-capability", () => ({
  issueBrowserCapabilities: capability.issue,
}))

import { acquireRelayBrowserCredentials as acquireLease } from "./relay-browser-credentials"

// The coordinator is a module singleton; release every lease even when an
// assertion fails so later cases start from an empty registry.
const cleanups: Array<() => void> = []

function acquireRelayBrowserCredentials(relayId: string, instanceId: string) {
  const lease = acquireLease(relayId, instanceId)
  cleanups.push(lease.release)
  return lease
}

/** Key generation is real WebCrypto in production; a resolved fake keeps
 * issuance on microtasks. */
beforeEach(() => {
  vi.stubGlobal("crypto", {
    subtle: {
      exportKey: vi.fn().mockResolvedValue({
        crv: "P-256",
        kty: "EC",
        x: "x".repeat(43),
        y: "y".repeat(43),
      }),
      generateKey: vi.fn().mockResolvedValue({ privateKey: {}, publicKey: {} }),
    },
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  capability.issue.mockReset()
  vi.unstubAllGlobals()
})

describe("Relay browser credential coordinator", () => {
  it("never hands a read-only console request a writable capability", async () => {
    capability.issue.mockImplementation(
      async ({
        data,
      }: {
        data: {
          requests: Array<{ kind: "console"; write: boolean }>
        }
      }) => ({
        capabilities: data.requests.map((request) => ({
          browserOrigin: "https://relay.example.com",
          capability: request.write ? "writable.signature" : "read.signature",
          expiresAt: Date.now() + 60_000,
          kind: request.kind,
          proxyMode: "none",
          relayId: "relay-one",
          version: 2,
        })),
      })
    )
    const readLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const writeLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )

    const [readCapability, writeCapability] = await Promise.all([
      readLease.issue({ kind: "console", optInV2: true, write: false }),
      writeLease.issue({ kind: "console", optInV2: true, write: true }),
    ])

    expect(readCapability.capability).toBe("read.signature")
    expect(writeCapability.capability).toBe("writable.signature")
  })
})
