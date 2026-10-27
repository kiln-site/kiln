import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"

vi.mock("@/lib/relay-registry", () => ({
  loadRelayCredentials: vi.fn(async () => ({ caCertificatePem: "pinned" })),
}))

import type { PersistedRelay } from "@/lib/relay-registry"
import { sourceEndpoints } from "@/server/relay-transfers.server"

afterEach(() => {
  vi.unstubAllEnvs()
})

it("keeps the way through Hearth when the source shares Hearth's address", async () => {
  // Behind one router, the source and Hearth answer at the same origin.
  vi.stubEnv("KILN_URL", "https://203.0.113.9")
  const source = {
    browserOrigin: "https://203.0.113.9",
    hostname: "203.0.113.9",
    id: "source-relay",
    port: 443,
    useTls: true,
  } as PersistedRelay
  const endpoints = await Effect.runPromise(sourceEndpoints(source))
  expect(endpoints).toEqual([
    { caCertificatePem: "pinned", url: "https://203.0.113.9:443" },
    { caCertificatePem: null, url: "https://203.0.113.9" },
    {
      caCertificatePem: null,
      url: "https://203.0.113.9/api/relays/source-relay/peer",
    },
  ])
})
