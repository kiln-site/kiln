import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("@/lib/access-control", () => ({
  isPlatformAdmin: () => false,
  isRelayCreator: () => false,
  listUserGrants: () => Promise.resolve([]),
  visibleRelaysForUser: () => [],
}))

vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: () => Promise.resolve([]),
}))

vi.mock("@/lib/relay-connection", () => ({
  relayConnectionState: () => ({
    lastError: null,
    status: "disconnected",
    updatedAt: 0,
  }),
}))

import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { openAuthorizedRealtimeStream } from "./realtime"

const user = {
  email: "user@example.com",
  emailVerified: true,
  id: "user-one",
  isDevelopmentBypass: false,
  name: "User",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

describe("authorized realtime stream", () => {
  it("marks authorization-changing resets without clearing browser state", async () => {
    const lifecycle = new AbortController()
    const stream = await openAuthorizedRealtimeStream({
      sessionId: null,
      signal: lifecycle.signal,
      user,
    })
    const reader = stream.getReader()
    await reader.read() // Initial Hearth refresh.

    publishRealtimeChange({
      reauthenticate: false,
      type: "access.changed",
      userIds: [user.id],
    })
    const next = await reader.read()
    lifecycle.abort()

    expect(next.done).toBe(false)
    expect(decodeEvent(next.value!)).toMatchObject({
      authorization: true,
      clear: false,
      hearth: true,
      type: "reset",
    })
  })
})

function decodeEvent(frame: Uint8Array): Record<string, unknown> {
  const data = new TextDecoder()
    .decode(frame)
    .split("\n")
    .find((line) => line.startsWith("data: "))
  if (!data) throw new Error("SSE data frame is missing")
  return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>
}
