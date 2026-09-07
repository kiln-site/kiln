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
    expect(capability.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requests: [
            { kind: "console", optInV2: false, write: true },
            { kind: "resources", optInV2: false },
          ],
        }),
      })
    )
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

  it("batches simultaneous renewals and never mints unused capabilities", async () => {
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
    expect(capability.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requests: [
            { kind: "console", optInV2: true, write: true },
            { kind: "resources", optInV2: true },
          ],
        }),
      })
    )
    capability.issue.mockClear()
    await consoleLease.renew({ kind: "console", optInV2: true, write: true })
    expect(capability.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requests: [{ kind: "console", optInV2: true, write: true }],
        }),
      })
    )
    consoleLease.release()
    resourceLease.release()
  })

  it("separates same-kind requests with different authority shapes", async () => {
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

    expect(capability.issue).toHaveBeenCalledTimes(2)
    expect(capability.issue.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          requests: [{ kind: "console", optInV2: true, write: false }],
        }),
      })
    )
    expect(capability.issue.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          requests: [{ kind: "console", optInV2: true, write: true }],
        }),
      })
    )
    expect(readCapability.capability).toBe("read.signature")
    expect(writeCapability.capability).toBe("writable.signature")
    readLease.release()
    writeLease.release()
  })

  it("does not block a late resource request on slow console issuance", async () => {
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
    let resolveConsole!: (value: { capabilities: Array<never> }) => void
    capability.issue.mockImplementation(
      ({ data }: { data: { requests: Array<{ kind: string }> } }) =>
        data.requests[0]?.kind === "console"
          ? new Promise((resolve) => {
              resolveConsole = resolve
            })
          : Promise.resolve({
              capabilities: [
                {
                  browserOrigin: "https://relay.example.com",
                  capability: "resources.signature",
                  expiresAt: Date.now() + 60_000,
                  kind: "resources",
                  proxyMode: "none",
                  relayId: "relay-one",
                  version: 2,
                },
              ],
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
    const consoleIssue = consoleLease.issue({
      kind: "console",
      optInV2: true,
      write: true,
    })
    await vi.waitFor(() => expect(capability.issue).toHaveBeenCalledOnce())

    const resourceIssue = resourceLease.issue({
      kind: "resources",
      optInV2: true,
    })

    await expect(resourceIssue).resolves.toEqual(
      expect.objectContaining({ capability: "resources.signature" })
    )
    expect(capability.issue).toHaveBeenCalledTimes(2)
    consoleLease.release()
    await expect(consoleIssue).rejects.toThrow("credentials were released")
    resolveConsole({ capabilities: [] })
    resourceLease.release()
  })

  it("deduplicates an identical request while issuance is in flight", async () => {
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
    let resolveIssuance!: (value: {
      capabilities: Array<{
        browserOrigin: string
        capability: string
        expiresAt: number
        kind: "console"
        proxyMode: "none"
        relayId: string
        version: 2
      }>
    }) => void
    capability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveIssuance = resolve
      })
    )
    const firstLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const secondLease = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const request = { kind: "console", optInV2: true, write: true } as const
    const first = firstLease.issue(request)
    await vi.waitFor(() => expect(capability.issue).toHaveBeenCalledOnce())

    const second = secondLease.issue(request)
    resolveIssuance({
      capabilities: [
        {
          browserOrigin: "https://relay.example.com",
          capability: "shared.signature",
          expiresAt: Date.now() + 60_000,
          kind: "console",
          proxyMode: "none",
          relayId: "relay-one",
          version: 2,
        },
      ],
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ capability: "shared.signature" }),
      expect.objectContaining({ capability: "shared.signature" }),
    ])
    expect(capability.issue).toHaveBeenCalledOnce()
    firstLease.release()
    secondLease.release()
  })

  it("aborts an in-flight issuance after its last owning lease releases", async () => {
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
    let issuanceSignal: AbortSignal | undefined
    capability.issue.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          issuanceSignal = signal
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
    )
    const lease = acquireRelayBrowserCredentials("relay-one", "instance-one")
    const issued = lease.issue({
      kind: "console",
      optInV2: true,
      write: true,
    })
    const rejected = expect(issued).rejects.toThrow("credentials were released")
    await vi.waitFor(() => expect(issuanceSignal).toBeDefined())

    lease.release()

    await rejected
    expect(issuanceSignal?.aborted).toBe(true)
    expect(capability.issue).toHaveBeenCalledOnce()
  })

  it("queues a new owner behind an aborted in-flight batch", async () => {
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
    let firstSignal: AbortSignal | undefined
    capability.issue
      .mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            firstSignal = signal
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            )
          })
      )
      .mockResolvedValueOnce({
        capabilities: [
          {
            browserOrigin: "https://relay.example.com",
            capability: "replacement.signature",
            expiresAt: Date.now() + 60_000,
            kind: "console",
            proxyMode: "none",
            relayId: "relay-one",
            version: 2,
          },
        ],
      })
    const abandoned = acquireRelayBrowserCredentials(
      "relay-one",
      "instance-one"
    )
    const keeper = acquireRelayBrowserCredentials("relay-one", "instance-one")
    const request = { kind: "console", optInV2: true, write: true } as const
    const abandonedIssue = abandoned.issue(request)
    const rejected = expect(abandonedIssue).rejects.toThrow(
      "credentials were released"
    )
    await vi.waitFor(() => expect(firstSignal).toBeDefined())
    abandoned.release()

    const replacement = keeper.issue(request)

    await rejected
    await expect(replacement).resolves.toEqual(
      expect.objectContaining({ capability: "replacement.signature" })
    )
    expect(firstSignal?.aborted).toBe(true)
    expect(capability.issue).toHaveBeenCalledTimes(2)
    keeper.release()
  })

  it("retains the authorization signal while a retry waits without credentials", () => {
    const lease = acquireRelayBrowserCredentials("relay-one", "instance-one")
    const signal = relayBrowserAuthorizationSignal("relay-one", "instance-one")
    const listener = vi.fn()
    const unsubscribe = signal.subscribe(listener)
    lease.release()

    notifyRelayBrowserAuthorizationChanged()

    expect(listener).toHaveBeenCalledOnce()
    expect(signal.getSnapshot()).toBe(1)
    unsubscribe()
    expect(signal.getSnapshot()).toBe(0)
  })
})
