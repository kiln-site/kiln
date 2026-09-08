import { Effect } from "effect"
import { relayInstanceSchema, relayNodeSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

import type { AccessGrant } from "@/lib/access-control"

const initialPolicy = vi.hoisted(() => ({
  delay: undefined as Promise<void> | undefined,
  grants: [] as AccessGrant[],
}))

vi.mock("@/lib/access-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-control")>()),
  refreshRelayAuthorizationUserEffect: ({ user }: { user: unknown }) =>
    Effect.promise(async () => {
      await initialPolicy.delay
      return { user }
    }),
  listUserGrants: () => Promise.resolve(initialPolicy.grants),
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
  role: "admin",
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

  it.each([false, true])(
    "gates snapshot node deltas independently of child instances (relay.read: %s)",
    async (readNode) => {
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
      })
      const node = relayNodeSchema.parse({
        id: "node-one",
        name: "Private node",
        version: "private-version",
        platform: "linux",
        arch: "arm64",
        cpu: { cores: 8, loadPercent: 30 },
        memory: { totalBytes: 100, usedBytes: 50 },
        storage: { totalBytes: 1000, usedBytes: 500 },
        docker: { available: true, version: "private-docker" },
        connectedAt: "2026-09-08T12:00:00.000Z",
      })
      initialPolicy.grants = [
        {
          id: "child",
          relayId: "relay-one",
          resourceId: instance.id,
          resourceType: "instance",
          role: "viewer",
          permissions: ["instance.read"],
        },
        ...(readNode
          ? [
              {
                id: "node",
                relayId: "relay-one",
                resourceId: "relay-one",
                resourceType: "relay" as const,
                role: "viewer" as const,
                permissions: ["relay.read" as const],
              },
            ]
          : []),
      ]
      const lifecycle = new AbortController()
      try {
        const stream = await openAuthorizedRealtimeStream({
          sessionId: null,
          signal: lifecycle.signal,
          user: { ...user, role: "user" },
        })
        const reader = stream.getReader()
        await reader.read()
        publishRealtimeChange({
          type: "relay.snapshot.delta",
          relayId: "relay-one",
          directoryChanged: false,
          delta: {
            node,
            instances: [instance, { ...instance, id: "b".repeat(40) }],
            deletedInstanceIds: [],
          },
        })
        // A later delivered event bounds the read without timers or absent-frame polling.
        publishRealtimeChange({
          type: "relay.state",
          relayId: "relay-one",
          status: "connected",
        })
        const frames: Array<Record<string, unknown>> = []
        while (true) {
          const frame = await reader.read()
          if (frame.done) throw new Error("Stream closed before the marker")
          const event = decodeEvent(frame.value)
          if (event.type === "relay.status") break
          frames.push(event)
        }
        expect(frames[0]).toMatchObject({
          type: "instances.delta",
          upserted: [{ id: instance.id }],
        })
        expect(frames[0]!.upserted as unknown[]).toHaveLength(1)
        expect(
          frames.filter((event) => event.type === "nodes.delta")
        ).toHaveLength(readNode ? 1 : 0)
        if (readNode)
          expect(frames[1]).toMatchObject({
            nodes: [{ ...node, relayId: "relay-one" }],
          })
        else expect(JSON.stringify(frames)).not.toContain("private-")
      } finally {
        lifecycle.abort()
        initialPolicy.grants = []
      }
    }
  )
})

function decodeEvent(frame: Uint8Array): Record<string, unknown> {
  const data = new TextDecoder()
    .decode(frame)
    .split("\n")
    .find((line) => line.startsWith("data: "))
  if (!data) throw new Error("SSE data frame is missing")
  return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>
}
