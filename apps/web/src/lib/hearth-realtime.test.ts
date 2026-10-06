import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

import { queryKeys } from "@/lib/query-options"
import { refreshHearthRealtimeTopics } from "./hearth-realtime"

const backupRunsKey = queryKeys.backups.runs({
  direction: "desc",
  scope: null,
  search: "",
  sort: "createdAt",
  status: null,
})
const searchedBackupRunsKey = queryKeys.backups.runs({
  direction: "desc",
  scope: null,
  search: "alpha",
  sort: "createdAt",
  status: null,
})
const targetSortedBackupRunsKey = queryKeys.backups.runs({
  direction: "asc",
  scope: null,
  search: "",
  sort: "target",
  status: null,
})

describe("Hearth realtime query refresh", () => {
  it("refreshes pending invitations and open invitation details on access changes", async () => {
    for (const scope of [undefined, { relayId: "relay-a" }]) {
      const client = new QueryClient()
      client.setQueryData(["my-resource-invitations"], [])
      client.setQueryData(["platform-invitations", 0], [])
      client.setQueryData(["resource-invitation", "invite-a"], {
        pending: true,
      })
      client.setQueryData(["unrelated"], {})
      await refreshHearthRealtimeTopics(client, ["access"], scope)
      expect(
        client.getQueryState(["my-resource-invitations"])?.isInvalidated
      ).toBe(true)
      expect(
        client.getQueryState(["resource-invitation", "invite-a"])?.isInvalidated
      ).toBe(true)
      // Platform lists refresh only on unscoped (administrator) invalidations.
      expect(
        client.getQueryState(["platform-invitations", 0])?.isInvalidated
      ).toBe(scope === undefined)
      expect(client.getQueryState(["unrelated"])?.isInvalidated).toBe(false)
    }
  })

  it("surfaces refetch failures so the realtime queue can retry them", async () => {
    const cause = new Error("offline")
    const invalidateQueries = vi.fn().mockRejectedValue(cause)

    await expect(
      refreshHearthRealtimeTopics(
        {
          getQueryCache: () => ({ findAll: () => [] }),
          invalidateQueries,
        } as unknown as QueryClient,
        ["relays"]
      )
    ).rejects.toBe(cause)
  })

  it("refreshes only backup views whose results depend on target names", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(backupRunsKey, { pageParams: [null], pages: [] })
    queryClient.setQueryData(searchedBackupRunsKey, {
      pageParams: [null],
      pages: [],
    })
    queryClient.setQueryData(targetSortedBackupRunsKey, {
      pageParams: [null],
      pages: [],
    })

    await refreshHearthRealtimeTopics(queryClient, ["database-directory"])

    expect(queryClient.getQueryState(backupRunsKey)?.isInvalidated).toBe(false)
    expect(
      queryClient.getQueryState(searchedBackupRunsKey)?.isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(targetSortedBackupRunsKey)?.isInvalidated
    ).toBe(true)
  })

  it("expires credentials for an affected Relay identity change", async () => {
    const queryClient = new QueryClient()
    const relayACredential = queryKeys.databases.credential(
      "relay-a",
      "a".repeat(40)
    )
    const relayBCredential = queryKeys.databases.credential(
      "relay-b",
      "b".repeat(40)
    )
    queryClient.setQueryData(relayACredential, {})
    queryClient.setQueryData(relayBCredential, {})

    await refreshHearthRealtimeTopics(queryClient, ["relays"], {
      relayId: "relay-a",
    })

    expect(queryClient.getQueryState(relayACredential)?.isInvalidated).toBe(
      true
    )
    expect(queryClient.getQueryState(relayBCredential)?.isInvalidated).toBe(
      false
    )
  })
})
