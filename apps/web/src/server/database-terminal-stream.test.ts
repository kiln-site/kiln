import { describe, expect, it, vi } from "vite-plus/test"

import type { DatabaseTerminalStreamRecord } from "@/lib/database-terminal-stream"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"

// The Relay, the sign-in lookup, and the access policy are the boundaries the
// stream checks against; each test sets what they answer.
const boundary = vi.hoisted(() => ({
  allowed: true,
  attachmentIds: [] as Array<string>,
  detached: [] as Array<string>,
  // The session ends while the page is still attaching.
  endsWhileAttaching: false,
  renewals: 0,
  signedIn: true,
}))

vi.mock("@/server/managed-database-access", () => ({
  databaseRpc: async (
    _relay: unknown,
    operation: string,
    payload: { attachmentId?: string }
  ) => {
    if (operation === "database.terminal.attach") {
      boundary.attachmentIds.push(payload.attachmentId!)
      if (boundary.endsWhileAttaching) {
        const { deliverDatabaseTerminalOutput } =
          await import("@/server/database-terminal-hub")
        deliverDatabaseTerminalOutput("relay-one", {
          attachmentId: payload.attachmentId!,
          cols: 80,
          data: "",
          ended: { at: "2026-01-01T00:00:01.000Z", reason: "exited" },
          offset: 0,
          rows: 24,
          sessionId: `boot0000.${"s".repeat(24)}`,
        })
      }
      return {
        cols: 80,
        offset: 0,
        previous: null,
        rows: 24,
        sessionId: `boot0000.${"s".repeat(24)}`,
        snapshot: "",
        startedAt: "2026-01-01T00:00:00.000Z",
      }
    }
    if (operation === "database.terminal.heartbeat") boundary.renewals += 1
    if (operation === "database.terminal.detach") {
      boundary.detached.push(payload.attachmentId!)
      return { detached: true }
    }
    return { unknown: [] }
  },
  requiredCredential: async () => ({
    databaseName: "kiln_app",
    password: "correct-horse-battery-staple-1",
    username: "kiln_user",
  }),
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
import { deliverDatabaseTerminalOutput } from "./database-terminal-hub"
import { openDatabaseTerminalStream } from "./database-terminal-stream"

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
  boundary.endsWhileAttaching = false
  boundary.signedIn = true
  const page = new AbortController()
  const reader = openDatabaseTerminalStream({
    authSessionId: "sign-in-one",
    cols: 80,
    databaseId: "e".repeat(40),
    headers: new Headers(),
    relay,
    restart: false,
    rows: 24,
    signal: page.signal,
    user,
  }).getReader()
  const decoder = new TextDecoder()
  const next = async (): Promise<DatabaseTerminalStreamRecord | null> => {
    const { done, value } = await reader.read()
    return done ? null : JSON.parse(decoder.decode(value))
  }
  expect(await next()).toMatchObject({ type: "attached", user: "kiln_user" })
  const attachmentId = boundary.attachmentIds.at(-1)!
  const output = (data: string) =>
    deliverDatabaseTerminalOutput(relay.id, {
      attachmentId,
      cols: 80,
      data: Buffer.from(data).toString("base64"),
      ended: null,
      offset: 0,
      rows: 24,
      sessionId: `boot0000.${"s".repeat(24)}`,
    })
  return { attachmentId, next, output, page }
}

describe("database terminal stream", () => {
  it("stops renewing a session that ended while the page was attaching", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    boundary.endsWhileAttaching = true
    boundary.renewals = 0
    const reader = openDatabaseTerminalStream({
      authSessionId: "sign-in-one",
      cols: 80,
      databaseId: "e".repeat(40),
      headers: new Headers(),
      relay,
      restart: false,
      rows: 24,
      signal: new AbortController().signal,
      user,
    }).getReader()
    const decoder = new TextDecoder()
    const records: Array<DatabaseTerminalStreamRecord> = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      records.push(JSON.parse(decoder.decode(value)))
    }

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    vi.useRealTimers()

    expect(records.at(-1)).toMatchObject({ type: "ended" })
    expect(boundary.renewals).toBe(0)
  })

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
    expect(stream.output("select * from secrets;")).toEqual({
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
    expect(stream.output("select * from secrets;")).toEqual({
      accepted: false,
    })
  })

  it("detaches a page that stops reading instead of holding its output", async () => {
    const stream = await openStream()
    const chunk = "x".repeat(64 * 1024)

    let accepted = true
    for (let sent = 0; accepted && sent < 64; sent += 1) {
      accepted = stream.output(chunk).accepted
    }

    expect(accepted).toBe(false)
    expect(await stream.next()).toMatchObject({
      code: "detached",
      type: "error",
    })
    expect(await stream.next()).toBeNull()
    expect(boundary.detached).toContain(stream.attachmentId)
    stream.page.abort()
  })
})
