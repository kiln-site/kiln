import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

// The sign-in lookup and the OTLP backend are the boundaries the endpoint
// talks to; each test sets who is signed in and records what reaches the
// backend.
const boundary = vi.hoisted(() => ({
  signedIn: true,
  forwarded: [] as Array<{ url: string; headers: Headers; body: unknown }>,
}))

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedRealtimeIdentityFromHeaders: async () =>
    boundary.signedIn
      ? { sessionId: "session-one", user: { id: crypto.randomUUID() } }
      : null,
}))

import { forwardBrowserTelemetry } from "./browser-telemetry"

function telemetryRequest(body: unknown): Request {
  return new Request("https://hearth.example.com/api/telemetry/v1/x", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("browser telemetry forwarding", () => {
  beforeEach(() => {
    boundary.signedIn = true
    boundary.forwarded = []
    // The query parameter must survive appending the signal path.
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "https://otlp.example.com/otlp?tenant=one"
    )
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20secret")
    vi.stubEnv("OTEL_TRACES_SAMPLER_ARG", "0.5")
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      boundary.forwarded.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      })
      return new Response(null, { status: 200 })
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("refuses signed-out browsers without forwarding", async () => {
    boundary.signedIn = false
    const response = await forwardBrowserTelemetry(
      telemetryRequest({ resourceLogs: [] }),
      "logs"
    )
    expect(response.status).toBe(401)
    expect(boundary.forwarded).toEqual([])
  })

  it("refuses oversized and malformed payloads without forwarding", async () => {
    const oversized = await forwardBrowserTelemetry(
      telemetryRequest("x".repeat(300 * 1024)),
      "logs"
    )
    const malformed = await forwardBrowserTelemetry(
      telemetryRequest("{not json"),
      "logs"
    )
    expect(oversized.status).toBe(413)
    expect(malformed.status).toBe(400)
    expect(boundary.forwarded).toEqual([])
  })
})
