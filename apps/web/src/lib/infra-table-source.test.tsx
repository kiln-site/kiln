import * as React from "react"
import { renderToString } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it, vi } from "vite-plus/test"

vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: vi.fn(),
}))

import { useInfraTableSource } from "@/lib/infra-table-source"
import { instanceStateQueryKey } from "@/lib/instance-state"

it("renders directory rows before live data without presenting cached runtime state as current", () => {
  const client = new QueryClient()
  const reference = { kind: "app" as const, id: "app-a", relayId: "relay-a" }
  client.setQueryData(instanceStateQueryKey(reference), {
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
      directory: {
        data: [{ ...reference, name: "My app" }],
        isLoading: false,
        isError: false,
      },
      reference: (row) => row,
      error: new Error("Directory unavailable"),
      retry: () => {},
    })
    return (
      <>
        {source.rows.map((row) => (
          <span key={row.id}>
            {row.name} · {row.instanceStatus} · {row.detailPhase}
          </span>
        ))}
      </>
    )
  }
  try {
    const markup = renderToString(
      <QueryClientProvider client={client}>
        <React.Suspense fallback="Waiting for the whole table">
          <Table />
        </React.Suspense>
      </QueryClientProvider>
    )
    expect(markup).toContain("My app")
    expect(markup).toContain("Checking")
    expect(markup).not.toContain("Running")
    expect(markup).not.toContain("Waiting for the whole table")
  } finally {
    client.clear()
  }
})
