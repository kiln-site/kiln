import { QueryClient } from "@tanstack/react-query"
import type {
  InstanceObservation,
  InstanceReference,
  InstanceInventoryRequest,
} from "@workspace/contracts"
import { AsyncLocalStorage } from "node:async_hooks"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const endpoint = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: endpoint.read,
}))

import { instanceInventoryQueryOptions } from "./instance-inventory"

const reference = (id: string) => ({
  kind: "database" as const,
  relayId: "relay-a",
  id,
})
const observation = (reference: InstanceReference): InstanceObservation => ({
  ...reference,
  reachability: "connected",
  runtime: "running",
  inventory: "available",
  updating: false,
})
const clients: Array<QueryClient> = []
const client = () => {
  const value = new QueryClient()
  clients.push(value)
  return value
}
afterEach(() => {
  for (const queryClient of clients.splice(0)) queryClient.clear()
  endpoint.read.mockReset()
})

describe("instance status reads while Hearth renders a page", () => {
  it("reads each page's lookups as that page's own request", async () => {
    // Who Hearth answers as: the request a read runs in.
    const request = new AsyncLocalStorage<string>()
    endpoint.read.mockImplementation(
      async ({ data }: { data: Array<InstanceInventoryRequest> }) => {
        const reader = request.getStore()
        return data.map((lookup) => ({
          request: lookup,
          value: {
            kind: "database",
            view: "status",
            data: null,
            observation: { ...observation(lookup.reference), id: reader },
          },
        }))
      }
    )
    const render = (reader: string, id: string) =>
      request.run(reader, () =>
        client().fetchQuery(
          instanceInventoryQueryOptions(reference(id), "status")
        )
      )
    const [alice, bob] = await Promise.all([
      render("alice", "first"),
      render("bob", "second"),
    ])
    expect(alice.observation.id).toBe("alice")
    expect(bob.observation.id).toBe("bob")
  })
})
