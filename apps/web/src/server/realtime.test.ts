import { Effect } from "effect"
import { relayInstanceSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

const initialPolicy = vi.hoisted(() => ({
  delay: undefined as Promise<void> | undefined,
}))

vi.mock("@/lib/access-control", () => ({
  isPlatformAdmin: () => true,
  refreshRelayAuthorizationUserEffect: ({ user }: { user: unknown }) =>
    Effect.promise(async () => {
      await initialPolicy.delay
      return { user }
    }),
  isRelayCreator: () => false,
  listUserGrants: () => Promise.resolve([]),
  visibleRelaysForUser: (_user: unknown, relays: unknown) => relays,
}))

vi.mock("@/effect/runtime", () => ({
  runAppEffect: (_name: string, effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
}))

vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: () =>
    Promise.resolve([{ id: "relay-one", name: "Relay", enabled: true }]),
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
  it("observes revocation while the initial database policy is still loading", async () => {
    let release!: () => void
    initialPolicy.delay = new Promise<void>((resolve) => {
      release = resolve
    })
    const lifecycle = new AbortController()
    const opening = openAuthorizedRealtimeStream({
      sessionId: null,
      signal: lifecycle.signal,
      user,
    })
    publishRealtimeChange({
      type: "access.changed",
      userIds: [user.id],
      reauthenticate: true,
    })
    release()
    try {
      await expect(opening).rejects.toThrow("authorization changed")
    } finally {
      initialPolicy.delay = undefined
      lifecycle.abort()
    }
  })

  it("removes startup variables and source credentials from emitted instance deltas", async () => {
    const lifecycle = new AbortController()
    const stream = await openAuthorizedRealtimeStream({
      sessionId: null,
      signal: lifecycle.signal,
      user,
    })
    const reader = stream.getReader()
    await reader.read()
    const instance = relayInstanceSchema.parse({
      connectAddress: "server.test",
      containerId: null,
      desiredState: "running",
      directory: "a".repeat(40),
      game: "Minecraft",
      id: "a".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      name: "Server",
      observedState: "running",
      service: "server",
      shortId: "aaaaaaaa",
      status: "running",
      version: "1.21.11",
      variables: { password: "startup-secret" },
      brickSource:
        "https://user:source-secret@example.com/brick.yaml?token=query-secret",
    })
    publishRealtimeChange({
      type: "instance.upsert",
      relayId: "relay-one",
      instance,
    })
    const next = await reader.read()
    lifecycle.abort()
    const frame = new TextDecoder().decode(next.value!)
    expect(frame).not.toContain("startup-secret")
    expect(frame).not.toContain("source-secret")
    expect(frame).not.toContain("query-secret")
    expect(frame).toContain("https://example.com/brick.yaml")
    expect(instance.variables?.password).toBe("startup-secret")
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
