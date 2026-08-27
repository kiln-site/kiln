import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vite-plus/test"

import { queryKeys } from "@/lib/query-options"
import { refreshHearthRealtimeTopics } from "./hearth-realtime"

describe("Hearth realtime query refresh", () => {
  it("invalidates only the requested domain", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relays, [{ id: "relay-a" }])
    queryClient.setQueryData(queryKeys.schedules.all, [{ id: "schedule-a" }])

    await refreshHearthRealtimeTopics(queryClient, ["relays", "relays"])

    expect(queryClient.getQueryState(queryKeys.relays)?.isInvalidated).toBe(
      true
    )
    expect(
      queryClient.getQueryState(queryKeys.schedules.all)?.isInvalidated
    ).toBe(false)
  })
})
