import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

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

  it("surfaces refetch failures so the realtime queue can retry them", async () => {
    const cause = new Error("offline")
    const invalidateQueries = vi.fn().mockRejectedValue(cause)

    await expect(
      refreshHearthRealtimeTopics(
        { invalidateQueries } as unknown as QueryClient,
        ["relays"]
      )
    ).rejects.toBe(cause)
    expect(invalidateQueries).toHaveBeenCalledWith(
      { exact: true, queryKey: queryKeys.relays },
      { throwOnError: true }
    )
  })

  it("refreshes only one scoped file activity query", async () => {
    const queryClient = new QueryClient()
    const firstActivity = queryKeys.fileActivity("relay-a", "instance-a")
    const secondActivity = queryKeys.fileActivity("relay-a", "instance-b")
    queryClient.setQueryData(firstActivity, { files: [] })
    queryClient.setQueryData(secondActivity, { files: [] })
    queryClient.setQueryData(queryKeys.relay.snapshot, { instances: [] })

    await refreshHearthRealtimeTopics(queryClient, ["file-activity"], {
      instanceId: "instance-a",
      relayId: "relay-a",
    })

    expect(queryClient.getQueryState(firstActivity)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(secondActivity)?.isInvalidated).toBe(
      false
    )
    expect(
      queryClient.getQueryState(queryKeys.relay.snapshot)?.isInvalidated
    ).toBe(false)
  })

  it("keeps access capabilities and invitation previews out of live refreshes", async () => {
    const queryClient = new QueryClient()
    const relayAUsers = queryKeys.access.instanceUsers("relay-a", "instance-a")
    const relayBUsers = queryKeys.access.instanceUsers("relay-b", "instance-b")
    const invitation = queryKeys.access.invitation("token")
    queryClient.setQueryData(queryKeys.access.overview, {})
    queryClient.setQueryData(queryKeys.access.capabilities, {})
    queryClient.setQueryData(relayAUsers, [])
    queryClient.setQueryData(relayBUsers, [])
    queryClient.setQueryData(invitation, {})

    await refreshHearthRealtimeTopics(queryClient, ["access"], {
      relayId: "relay-a",
    })

    expect(
      queryClient.getQueryState(queryKeys.access.overview)?.isInvalidated
    ).toBe(true)
    expect(queryClient.getQueryState(relayAUsers)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(relayBUsers)?.isInvalidated).toBe(false)
    expect(
      queryClient.getQueryState(queryKeys.access.capabilities)?.isInvalidated
    ).toBe(false)
    expect(queryClient.getQueryState(invitation)?.isInvalidated).toBe(false)
  })
})
