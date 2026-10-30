import { describe, expect, it, vi } from "vite-plus/test"
import { WebSocket } from "ws"

import {
  BrowserSessionRegistry,
  type BrowserSessionAuthority,
} from "./browser-session-registry.js"

const limits = {
  fileReplayEntries: 100,
  outboxBytes: 1024,
  outboxMessages: 16,
  pendingFileAuthentications: 2,
  pendingHandshakes: 2,
  pendingHandshakesPerIp: 1,
  sessions: 2,
  sessionsPerInstance: 1,
  sessionsPerUser: 1,
  sessionsPerUserInstance: 1,
  sublimitsEnforced: true,
}

describe("browser session registry", () => {
  it("admits file-only clients and lets an admitted transfer finish past token expiry", () => {
    vi.useFakeTimers()
    try {
      const registry = new BrowserSessionRegistry(limits)
      const abort = vi.fn()
      const transfer = registry.registerTransfer(
        authority({ operation: "file", expiresAt: Date.now() + 1_000 }),
        { issuerGeneration: 1, minimumRevision: 0 },
        abort
      )
      expect(transfer.active()).toBe(true)
      vi.advanceTimersByTime(1_000)
      expect(transfer.active()).toBe(true)
      expect(abort).not.toHaveBeenCalled()
      registry.revise(
        "hearth-a",
        [
          {
            subject: "user-a",
            scope: { kind: "subject_relay" },
            minimumRevision: 2,
          },
        ],
        1
      )
      expect(transfer.active()).toBe(false)
      expect(abort).toHaveBeenCalledOnce()
      transfer.release()
      registry.close()
      expect(abort).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies targeted floors and permits a fresh renewal", () => {
    const registry = new BrowserSessionRegistry(limits)
    const active = socket()
    registry.acquirePending(active, "192.0.2.1", true)
    expect(
      registry.activate(active, authority(), "relay-session-a", {
        issuerGeneration: 1,
        minimumRevision: 0,
      }).accepted
    ).toBe(true)
    registry.revise(
      "hearth-a",
      [
        {
          minimumRevision: 3,
          scope: { instanceId: "instance-a", kind: "instance" },
          subject: "user-a",
        },
      ],
      1
    )
    expect(registry.isActive(active, "instance.console.read")).toBe(false)
    expect(active.close).toHaveBeenCalledWith(4403, expect.any(String))

    const renewed = socket()
    registry.acquirePending(renewed, "192.0.2.2", true)
    expect(
      registry.activate(
        renewed,
        authority({ revision: 3 }),
        "relay-session-b",
        { issuerGeneration: 1, minimumRevision: 3 },
        { nonce: "nonce", nonceExpiresAt: Date.now() + 30_000 }
      ).accepted
    ).toBe(true)
    expect(registry.isActive(renewed, "instance.console.read")).toBe(true)
    registry.close()
  })

  it("rejects admission when durable and in-memory generations disagree", () => {
    const registry = new BrowserSessionRegistry(limits)
    const current = socket()
    registry.acquirePending(current, "192.0.2.1", true)
    expect(
      registry.activate(current, authority(), "relay-session-a", {
        issuerGeneration: 1,
        minimumRevision: 0,
      }).accepted
    ).toBe(true)
    registry.revise("hearth-a", [], 2)

    const afterRollback = socket()
    registry.acquirePending(afterRollback, "192.0.2.2", true)
    expect(
      registry.activate(afterRollback, authority(), "relay-session-b", {
        issuerGeneration: 1,
        minimumRevision: 0,
      })
    ).toEqual({
      accepted: false,
      reason: "authorization",
      replaced: null,
    })
    registry.close()
  })
})

function socket(): WebSocket & { close: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(),
    readyState: WebSocket.OPEN,
  } as unknown as WebSocket & {
    close: ReturnType<typeof vi.fn>
  }
}

function authority(
  overrides: Partial<BrowserSessionAuthority> = {}
): BrowserSessionAuthority {
  return {
    actions: new Set(["instance.console.read"]),
    expiresAt: Date.now() + 30_000,
    instanceId: "instance-a",
    issuer: "hearth-a",
    issuerGeneration: 1,
    keyThumbprint: "thumbprint-a",
    loginSessionId: "login-session-a",
    operation: "console",
    resourceKind: "instance",
    origin: "https://hearth.test",
    revision: 1,
    subject: "user-a",
    version: 2,
    ...overrides,
  }
}
