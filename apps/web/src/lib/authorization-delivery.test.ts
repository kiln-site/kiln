import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

const fakes = vi.hoisted(() => ({
  execute: vi.fn(),
  features: new Set<string>(),
  relayRpc: vi.fn(),
}))

vi.mock("@/lib/database", () => ({
  databasePool: {
    execute: fakes.execute,
    query: vi.fn(),
  },
}))

vi.mock("@/lib/relay-connection", () => ({
  relayConnectionFeatures: () => fakes.features,
  relayRpc: fakes.relayRpc,
}))

vi.mock("@/lib/relay-registry", () => ({
  loadPersistedRelay: () => Promise.resolve({ id: "relay-one" }),
}))

import {
  observeRelayIssuerGeneration,
  reviseRelayIssuerGenerationNow,
} from "./authorization-delivery"

describe("authorization delivery recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.features.clear()
    fakes.features.add("browser-capability-v2")
    fakes.execute.mockResolvedValue([{ affectedRows: 1 }])
    fakes.relayRpc.mockResolvedValue({ issuerGeneration: 9, items: [] })
  })

  it("raises Hearth's desired generation when Relay is ahead", async () => {
    await expect(reviseRelayIssuerGenerationNow("relay-one", 4)).resolves.toBe(
      true
    )

    expect(fakes.execute).toHaveBeenCalledOnce()
    expect(fakes.execute.mock.calls[0]?.[0]).toContain(
      "issuer_generation = GREATEST(issuer_generation, ?)"
    )
    expect(fakes.execute.mock.calls[0]?.[1]).toEqual([9, 9, "relay-one"])
  })

  it("turns a reported generation rollback into a durable pending advance", async () => {
    // Keep this unit focused on reconciliation SQL; delivery has its own worker
    // coverage and is intentionally asynchronous.
    fakes.features.clear()

    await observeRelayIssuerGeneration("relay-one", 3)

    expect(fakes.execute).toHaveBeenCalledTimes(2)
    expect(fakes.execute.mock.calls[0]?.[0]).toContain(
      "acknowledged_issuer_generation >= issuer_generation"
    )
    expect(fakes.execute.mock.calls[0]?.[1]).toEqual([
      3,
      "relay-one",
      3,
      Number.MAX_SAFE_INTEGER,
    ])
    expect(fakes.execute.mock.calls[1]?.[0]).toContain(
      "issuer_generation = GREATEST(issuer_generation, ?)"
    )
  })
})
