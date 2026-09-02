import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const capability = vi.hoisted(() => ({ issue: vi.fn() }))

vi.mock("@/server/relay-capability", () => ({
  issueBrowserCapabilities: capability.issue,
}))

import {
  acquireRelayBrowserCredentials,
  notifyRelayBrowserAuthorizationChanged,
  relayBrowserAuthorizationSignal,
} from "./relay-browser-credentials"

afterEach(() => {
  capability.issue.mockReset()
  vi.unstubAllGlobals()
})

describe("Relay browser credential coordinator", () => {
  it("batches active console and resource kinds onto one proof key", async () => {
    vi.stubGlobal("crypto", {
      subtle: {
        exportKey: vi.fn().mockResolvedValue({
          crv: "P-256",
          kty: "EC",
          x: "x".repeat(43),
          y: "y".repeat(43),
        }),
        generateKey: vi.fn().mockResolvedValue({
          privateKey: {},
          publicKey: {},
        }),
      },
    })
    capability.issue.mockImplementation(
      async ({ data }: { data: { requests: Array<{ kind: string }> } }) => ({
        capabilities: data.requests.map(({ kind }) => ({
          browserOrigin: "https://relay.example.com",
          capability: `${kind}.signature`,
          expiresAt: Date.now() + 60_000,
          kind,
          proxyMode: "none",
          relayId: "relay-one",
          version: 1,
        })),
      })
    )
    const consoleLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const resourceLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )

    const [consoleCapability, resourceCapability] = await Promise.all([
      consoleLease.issue({ kind: "console", optInV2: false, write: true }),
      resourceLease.issue({ kind: "resources", optInV2: false }),
    ])

    expect(capability.issue).toHaveBeenCalledOnce()
    expect(capability.issue).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requests: [
          { kind: "console", optInV2: false, write: true },
          { kind: "resources", optInV2: false },
        ],
      }),
    })
    expect(consoleCapability.kind).toBe("console")
    expect(resourceCapability.kind).toBe("resources")
    consoleLease.release()
    resourceLease.release()
  })

  it("notifies only active route-instance subscribers", () => {
    const lease = acquireRelayBrowserCredentials("relay-one", "instance-one")
    const signal = relayBrowserAuthorizationSignal("relay-one", "instance-one")
    const listener = vi.fn()
    const unsubscribe = signal.subscribe(listener)

    notifyRelayBrowserAuthorizationChanged()

    expect(listener).toHaveBeenCalledOnce()
    expect(signal.getSnapshot()).toBe(1)
    unsubscribe()
    lease.release()
  })

  it("coalesces a renewal into one batch for every active kind", async () => {
    vi.stubGlobal("crypto", {
      subtle: {
        exportKey: vi.fn().mockResolvedValue({
          crv: "P-256",
          kty: "EC",
          x: "x".repeat(43),
          y: "y".repeat(43),
        }),
        generateKey: vi.fn().mockResolvedValue({
          privateKey: {},
          publicKey: {},
        }),
      },
    })
    capability.issue.mockImplementation(
      async ({ data }: { data: { requests: Array<{ kind: string }> } }) => ({
        capabilities: data.requests.map(({ kind }) => ({
          browserOrigin: "https://relay.example.com",
          capability: `${kind}.signature`,
          expiresAt: Date.now() + 60_000,
          kind,
          proxyMode: "none",
          relayId: "relay-one",
          version: 2,
        })),
      })
    )
    const consoleLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const resourceLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    await Promise.all([
      consoleLease.issue({ kind: "console", optInV2: true, write: true }),
      resourceLease.issue({ kind: "resources", optInV2: true }),
    ])
    capability.issue.mockClear()

    await Promise.all([
      consoleLease.renew({ kind: "console", optInV2: true, write: true }),
      resourceLease.renew({ kind: "resources", optInV2: true }),
    ])

    expect(capability.issue).toHaveBeenCalledOnce()
    expect(capability.issue).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requests: [
          { kind: "console", optInV2: true, write: true },
          { kind: "resources", optInV2: true },
        ],
      }),
    })
    consoleLease.release()
    resourceLease.release()
  })
})
