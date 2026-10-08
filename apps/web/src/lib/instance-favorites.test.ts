import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

const server = vi.hoisted(() => ({
  getInstanceFavorites: vi.fn(),
  setInstanceFavorite: vi.fn(),
}))

vi.mock("@/server/instance-favorites", () => server)

import type { InstanceFavorite } from "@/lib/instance-favorites"
import {
  instanceFavoritesQueryOptions,
  setInstanceFavoriteMutationOptions,
} from "@/lib/query-options"

const first: InstanceFavorite = { id: "a", kind: "server", relayId: "relay" }
const second: InstanceFavorite = { id: "b", kind: "server", relayId: "relay" }
// Starred from another browser; only a refetch can show it.
const elsewhere: InstanceFavorite = {
  id: "c",
  kind: "database",
  relayId: "relay",
}

describe("instance favorite toggles", () => {
  it("keeps a later favorite when an earlier toggle fails", async () => {
    const queryClient = new QueryClient()
    const { queryKey } = instanceFavoritesQueryOptions()
    server.getInstanceFavorites.mockResolvedValue([second, elsewhere])
    queryClient.setQueryData(queryKey, [])
    const query = new QueryObserver(
      queryClient,
      instanceFavoritesQueryOptions()
    )
    const unsubscribe = query.subscribe(() => undefined)

    let failFirst: (error: Error) => void = () => undefined
    server.setInstanceFavorite
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          failFirst = reject
        })
      )
      .mockResolvedValueOnce(undefined)
    const failures: Array<string> = []
    const toggle = () =>
      new MutationObserver(
        queryClient,
        setInstanceFavoriteMutationOptions(queryClient, (error) =>
          failures.push(error.message)
        )
      )

    const pendingFirst = toggle()
      .mutate({ favorite: first, starred: true })
      .catch(() => undefined)
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKey)).toEqual([first])
    )
    await toggle().mutate({ favorite: second, starred: true })
    expect(queryClient.getQueryData(queryKey)).toEqual([first, second])

    failFirst(new Error("offline"))
    await pendingFirst
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(failures).toEqual(["offline"])
    expect(queryClient.getQueryData(queryKey)).toEqual([second, elsewhere])
    unsubscribe()
    queryClient.clear()
  })
})
