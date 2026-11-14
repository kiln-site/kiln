import { describe, expect, it, vi } from "vite-plus/test"

import type { TerminalStreamRecord } from "@/lib/terminal-connection"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"

// The Relay, the sign-in lookup, and the access policy are the boundaries the
// stream checks against; each test sets what they answer.
const boundary = vi.hoisted(() => ({
  allowed: true,
  attachmentIds: [] as Array<string>,
  detached: [] as Array<string>,
  signedIn: true,
}))

vi.mock("@/server/managed-database-access", () => ({
  databaseRpc: async (
    _relay: unknown,
    operation: string,
    payload: { attachmentId?: string }
  ) => {
    if (operation === "terminal.attach") {
      boundary.attachmentIds.push(payload.attachmentId!)
      return {
        cols: 80,
        control: "none",
        offset: 0,
        previous: null,
        rows: 24,
        seq: 0,
        sessionId: `boot0000.${"s".repeat(24)}`,
        snapshot: "",
        startedAt: "2026-01-01T00:00:00.000Z",
      }
    }
    if (operation === "terminal.detach") {
      boundary.detached.push(payload.attachmentId!)
      return { detached: true }
    }
    return { unknown: [] }
  },
  requiredRelay: async () => relay,
}))

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedRealtimeIdentityFromHeaders: async () =>
    boundary.signedIn ? { sessionId: "sign-in-one", user } : null,
}))

vi.mock("@/lib/access-control", () => ({
  requireRelayPermission: async () => {
    if (!boundary.allowed) throw new Error("Permission denied")
  },
}))

import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { deliverTerminalOutput } from "./terminal-hub"
import { openTerminalStream } from "./terminal-stream"

const user = {
  email: "user@example.com",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "user-one",
  isDevelopmentBypass: false,
  name: "User",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const relay = { enabled: true, id: "relay-one" } as PersistedRelay

async function openStream() {
  boundary.allowed = true
  boundary.signedIn = true
  const page = new AbortController()
  const reader = openTerminalStream({
    authSessionId: "sign-in-one",
    cols: 80,
    headers: new Headers(),
    relay,
    rows: 24,
    signal: page.signal,
    target: { kind: "database", id: "e".repeat(12) },
    user,
  }).getReader()
  const decoder = new TextDecoder()
  const next = async (): Promise<TerminalStreamRecord | null> => {
    const { done, value } = await reader.read()
    return done ? null : JSON.parse(decoder.decode(value))
  }
  expect(await next()).toMatchObject({ type: "attached" })
  const attachmentId = boundary.attachmentIds.at(-1)!
  const output = (data: string) =>
    deliverTerminalOutput(relay.id, {
      attachmentId,
      cols: 80,
      control: "none",
      data: Buffer.from(data).toString("base64"),
      ended: null,
      offset: 0,
      rows: 24,
      seq: 0,
      sessionId: `boot0000.${"s".repeat(24)}`,
    })
  return { attachmentId, next, output, page }
}

describe("terminal stream", () => {
  it("stops sending output once the person loses access to the terminal", async () => {
    const stream = await openStream()

    boundary.allowed = false
    publishRealtimeChange({
      reauthenticate: false,
      type: "access.changed",
      userIds: [user.id],
    })

    expect(await stream.next()).toMatchObject({
      code: "detached",
      type: "error",
    })
    expect(await stream.next()).toBeNull()
    expect(stream.output("cat /etc/shadow")).toEqual({
      accepted: false,
    })
    expect(boundary.detached).toContain(stream.attachmentId)
  })

  it("stops sending output once the person's sign-in is revoked", async () => {
    const stream = await openStream()

    boundary.signedIn = false
    publishRealtimeChange({
      sessionIds: ["sign-in-one"],
      type: "session.revoked",
    })

    expect(await stream.next()).toMatchObject({
      code: "detached",
      type: "error",
    })
    expect(await stream.next()).toBeNull()
    expect(stream.output("cat /etc/shadow")).toEqual({
      accepted: false,
    })
  })
})
