import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

import { queryKeys } from "@/lib/query-options"
import { refreshHearthRealtimeTopics } from "./hearth-realtime"

describe("Hearth realtime query refresh", () => {
  it("invalidates only the requested domain", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.backups.all, [{ id: "backup-a" }])
    queryClient.setQueryData(queryKeys.schedules.all, [{ id: "schedule-a" }])

    await refreshHearthRealtimeTopics(queryClient, ["backups", "backups"])

    expect(
      queryClient.getQueryState(queryKeys.backups.all)?.isInvalidated
    ).toBe(true)
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
    expect(queryClient.getQueryState(secondActivity)?.isInvalidated).toBe(false)
    expect(
      queryClient.getQueryState(queryKeys.relay.snapshot)?.isInvalidated
    ).toBe(false)
  })

  it("refreshes only the changed instance web routes", async () => {
    const queryClient = new QueryClient()
    const changedRoutes = queryKeys.relay.webRoutes("relay-a", "instance-a")
    const otherRoutes = queryKeys.relay.webRoutes("relay-a", "instance-b")
    queryClient.setQueryData(changedRoutes, { routes: [] })
    queryClient.setQueryData(otherRoutes, { routes: [] })

    await refreshHearthRealtimeTopics(queryClient, ["instance-web-routes"], {
      instanceId: "instance-a",
      relayId: "relay-a",
    })

    expect(queryClient.getQueryState(changedRoutes)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(otherRoutes)?.isInvalidated).toBe(false)
  })

  it("refreshes schedule targets when the instance directory changes", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.schedules.options, [])

    await refreshHearthRealtimeTopics(queryClient, ["instance-directory"], {
      instanceId: "instance-a",
      relayId: "relay-a",
    })

    expect(
      queryClient.getQueryState(queryKeys.schedules.options)?.isInvalidated
    ).toBe(true)
  })

  it("refreshes access capabilities but keeps invitation previews out", async () => {
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
    ).toBe(true)
    expect(queryClient.getQueryState(invitation)?.isInvalidated).toBe(false)
  })

  it("coalesces overlapping prefixes during full recovery", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined)

    await refreshHearthRealtimeTopics(
      { invalidateQueries } as unknown as QueryClient,
      ["databases", "database-directory", "database-credentials"]
    )

    expect(invalidateQueries).toHaveBeenCalledTimes(2)
    expect(invalidateQueries).toHaveBeenCalledWith(
      { exact: false, queryKey: ["databases"] },
      { throwOnError: true }
    )
    expect(invalidateQueries).toHaveBeenCalledWith(
      { exact: true, queryKey: queryKeys.schedules.options },
      { throwOnError: true }
    )
  })

  it("keeps Relay health checks out of mounted control-plane catalogs", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relays, [{ id: "relay-a" }])
    queryClient.setQueryData(queryKeys.backups.all, [{ id: "backup-a" }])
    queryClient.setQueryData(queryKeys.databases.list, [{ id: "database-a" }])

    await refreshHearthRealtimeTopics(queryClient, ["relay-health"], {
      relayId: "relay-a",
    })

    expect(queryClient.getQueryState(queryKeys.relays)?.isInvalidated).toBe(
      true
    )
    expect(
      queryClient.getQueryState(queryKeys.backups.all)?.isInvalidated
    ).toBe(false)
    expect(
      queryClient.getQueryState(queryKeys.databases.list)?.isInvalidated
    ).toBe(false)
  })

  it("keeps database list, directory, and credential refreshes precise", async () => {
    const queryClient = new QueryClient()
    const changedCredential = queryKeys.databases.credential(
      "relay-a",
      "a".repeat(40)
    )
    const otherCredential = queryKeys.databases.credential(
      "relay-a",
      "b".repeat(40)
    )
    queryClient.setQueryData(queryKeys.databases.list, {})
    queryClient.setQueryData(queryKeys.databases.directory, [])
    queryClient.setQueryData(queryKeys.schedules.options, [])
    queryClient.setQueryData(changedCredential, {})
    queryClient.setQueryData(otherCredential, {})

    await refreshHearthRealtimeTopics(
      queryClient,
      ["databases", "database-directory", "database-credentials"],
      {
        databaseId: "a".repeat(40),
        relayId: "relay-a",
      }
    )

    expect(
      queryClient.getQueryState(queryKeys.databases.list)?.isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(queryKeys.databases.directory)?.isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(queryKeys.schedules.options)?.isInvalidated
    ).toBe(true)
    expect(queryClient.getQueryState(changedCredential)?.isInvalidated).toBe(
      true
    )
    expect(queryClient.getQueryState(otherCredential)?.isInvalidated).toBe(
      false
    )
  })

  it("does not refresh database directories for status-only changes", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.databases.list, {})
    queryClient.setQueryData(queryKeys.databases.directory, [])
    queryClient.setQueryData(queryKeys.schedules.options, [])

    await refreshHearthRealtimeTopics(queryClient, ["databases"], {
      relayId: "relay-a",
    })

    expect(
      queryClient.getQueryState(queryKeys.databases.list)?.isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(queryKeys.databases.directory)?.isInvalidated
    ).toBe(false)
    expect(
      queryClient.getQueryState(queryKeys.schedules.options)?.isInvalidated
    ).toBe(false)
  })

  it("keeps backup catalog and settings refreshes independent", async () => {
    const queryClient = new QueryClient()
    const relayAPolicy = queryKeys.backups.policy("relay-a", {
      id: "instance-a",
      kind: "instance",
    })
    const relayBPolicy = queryKeys.backups.policy("relay-b", {
      id: "instance-b",
      kind: "instance",
    })
    queryClient.setQueryData(queryKeys.backups.all, [])
    queryClient.setQueryData(queryKeys.backups.storage, [])
    queryClient.setQueryData(relayAPolicy, {})
    queryClient.setQueryData(relayBPolicy, {})

    await refreshHearthRealtimeTopics(queryClient, ["backup-settings"], {
      relayId: "relay-a",
    })

    expect(
      queryClient.getQueryState(queryKeys.backups.storage)?.isInvalidated
    ).toBe(false)
    expect(queryClient.getQueryState(relayAPolicy)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(relayBPolicy)?.isInvalidated).toBe(false)
    expect(
      queryClient.getQueryState(queryKeys.backups.all)?.isInvalidated
    ).toBe(false)

    await refreshHearthRealtimeTopics(queryClient, ["backup-storage"])

    expect(
      queryClient.getQueryState(queryKeys.backups.storage)?.isInvalidated
    ).toBe(true)
    expect(queryClient.getQueryState(relayBPolicy)?.isInvalidated).toBe(false)
  })

  it("refreshes scoped Tailscale state without touching other Relays", async () => {
    const queryClient = new QueryClient()
    const relayATailscale = queryKeys.tailscale("relay-a")
    const relayBTailscale = queryKeys.tailscale("relay-b")
    queryClient.setQueryData(queryKeys.tailscaleStacks, [])
    queryClient.setQueryData(relayATailscale, {})
    queryClient.setQueryData(relayBTailscale, {})

    await refreshHearthRealtimeTopics(queryClient, ["tailscale"], {
      relayId: "relay-a",
    })

    expect(
      queryClient.getQueryState(queryKeys.tailscaleStacks)?.isInvalidated
    ).toBe(true)
    expect(queryClient.getQueryState(relayATailscale)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(relayBTailscale)?.isInvalidated).toBe(
      false
    )
  })

  it("refreshes every mounted activity date range", async () => {
    const queryClient = new QueryClient()
    const firstRange = queryKeys.activity("2026-01-01", "2026-01-31")
    const secondRange = queryKeys.activity("2026-02-01", "2026-02-28")
    queryClient.setQueryData(firstRange, {})
    queryClient.setQueryData(secondRange, {})

    await refreshHearthRealtimeTopics(queryClient, ["activity"])

    expect(queryClient.getQueryState(firstRange)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(secondRange)?.isInvalidated).toBe(true)
  })

  it("keeps Relay proxy writes out of unrelated control-plane queries", async () => {
    const queryClient = new QueryClient()
    const relayAProxy = ["relays", "proxy", "relay-a"] as const
    const relayBProxy = ["relays", "proxy", "relay-b"] as const
    queryClient.setQueryData(queryKeys.relays, [])
    queryClient.setQueryData(queryKeys.backups.all, [])
    queryClient.setQueryData(relayAProxy, {})
    queryClient.setQueryData(relayBProxy, {})

    await refreshHearthRealtimeTopics(queryClient, ["relay-proxy"], {
      relayId: "relay-a",
    })

    expect(queryClient.getQueryState(relayAProxy)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(relayBProxy)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(queryKeys.relays)?.isInvalidated).toBe(
      false
    )
    expect(
      queryClient.getQueryState(queryKeys.backups.all)?.isInvalidated
    ).toBe(false)
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
