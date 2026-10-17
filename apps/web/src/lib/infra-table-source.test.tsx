import { renderToString } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it, vi } from "vite-plus/test"

vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: vi.fn(),
}))

import { useInfraTableSource } from "@/lib/infra-table-source"
import { instanceInventoryQueryKey } from "@/lib/instance-inventory"

it("server-renders directory rows without presenting a cached runtime state as current", () => {
  const client = new QueryClient()
  const reference = { kind: "app" as const, id: "app-a", relayId: "relay-a" }
  client.setQueryData(instanceInventoryQueryKey(reference, "status"), {
    kind: "app",
    view: "status",
    data: null,
    observation: {
      ...reference,
      reachability: "connected",
      inventory: "available",
      runtime: "running",
      updating: false,
    },
  })
  function Table() {
    const source = useInfraTableSource({
      rows: [{ ...reference, name: "My app" }],
      reference: (row) => row,
    })
    return (
      <>
        {source.rows.map((row) => (
          <span key={row.id}>
            {row.name} · {row.instanceStatus}
          </span>
        ))}
      </>
    )
  }
  try {
    const markup = renderToString(
      <QueryClientProvider client={client}>
        <Table />
      </QueryClientProvider>
    )
    expect(markup).toContain("My app")
    expect(markup).toContain("Checking")
    expect(markup).not.toContain("Running")
  } finally {
    client.clear()
  }
})
