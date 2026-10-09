import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient } from "@tanstack/react-query"

const server = vi.hoisted(() => ({
  clearNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  getNotifications: vi.fn(),
  markNotificationsRead: vi.fn(
    async ({ data }: { data: { ids: Array<string> } }) => data.ids
  ),
}))
vi.mock("@/server/notifications", () => server)
import {
  markCachedNotificationsRead,
  notificationsQueryOptions,
} from "@/lib/collections/notifications"
import type { KilnNotification } from "@/lib/notifications"

const clients: Array<QueryClient> = []
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  server.markNotificationsRead.mockClear()
})

function unread(index: number): KilnNotification {
  return {
    content: {
      kind: "kiln.release",
      name: `v0.${index}.0`,
      url: `https://github.com/example/kiln/releases/tag/v0.${index}.0`,
      version: `0.${index}.0`,
    },
    createdAt: 1_000 + index,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    readAt: null,
  }
}

describe("opening the notifications popover", () => {
  it("reads only the notifications it shows", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(queryClient)
    const { queryKey } = notificationsQueryOptions()
    const inbox = Array.from({ length: 12 }, (_, index) => unread(12 - index))
    queryClient.setQueryData(queryKey, inbox)

    const shown = inbox.slice(0, 10).map(({ id }) => id)
    const unseen = inbox.slice(10).map(({ id }) => id)
    expect([...markCachedNotificationsRead(queryClient)]).toEqual(shown)

    await vi.waitFor(() =>
      expect(server.markNotificationsRead).toHaveBeenCalledWith({
        data: { ids: shown },
      })
    )
    const unreadAfter = (queryClient.getQueryData(queryKey) ?? [])
      .filter((notification) => notification.readAt === null)
      .map(({ id }) => id)
    expect(unreadAfter).toEqual(unseen)
  })
})
