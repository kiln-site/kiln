import {
  QueryClient,
  QueryObserver,
  environmentManager,
} from "@tanstack/react-query"
import type {
  InstanceObservation,
  InstanceReference,
  InstanceInventoryResult,
  InstanceInventoryRequest,
} from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const endpoint = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: endpoint.read,
}))

import {
  instanceStateFromQuery,
  instanceStateQueryOptions,
} from "./instance-state"
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

describe("instance status queries", () => {
  it("preserves workspace detail through an outage while clearing live status", async () => {
    const ref = { ...reference("first"), kind: "app" as const }
    endpoint.read.mockImplementation(
      async ({ data }: { data: Array<InstanceInventoryRequest> }) =>
        data.map((request) => ({
          request,
          value: {
            kind: "app",
            view: "detail",
            data: {
              id: ref.id,
              shortId: "first",
              hostname: "app-first",
              network: "app-first",
              connectedDatabaseIds: [],
              containers: [],
              dataDirectory: "/apps/first",
              deployment: null,
              observedState: "running",
              status: "Running",
            },
            observation: observation(ref),
          },
        }))
    )
    const observer = new QueryObserver(client(), {
      ...instanceInventoryQueryOptions(ref, "detail"),
      enabled: false,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      endpoint.read.mockImplementation(
        async ({ data }: { data: Array<InstanceInventoryRequest> }) =>
          data.map((request) => ({
            request,
            value: {
              kind: "app",
              view: "detail",
              data: null,
              observation: {
                ...observation(ref),
                inventory: "unavailable",
                reachability: "unreachable",
                runtime: null,
              },
            },
          }))
      )
      await observer.refetch()
      expect(observer.getCurrentResult().data).toMatchObject({
        data: { hostname: "app-first" },
        observation: {
          inventory: "unavailable",
          reachability: "unreachable",
          runtime: null,
        },
      })
    } finally {
      unsubscribe()
    }
  })

  it("resolves mixed status/table views with the data belonging to each view", async () => {
    endpoint.read.mockImplementation(
      async ({
        data,
      }: {
        data: Array<InstanceInventoryRequest>
      }): Promise<Array<InstanceInventoryResult>> =>
        data.map((request) => ({
          request,
          value:
            request.view === "table"
              ? {
                  kind: "app",
                  view: "table",
                  data: {
                    containerSearchText: "web nginx:latest",
                    containerCount: 2,
                    runningContainerCount: 1,
                    deploying: false,
                  },
                  observation: observation(request.reference),
                }
              : {
                  kind: "app",
                  view: "status",
                  data: null,
                  observation: observation(request.reference),
                },
        }))
    )
    const ref = { ...reference("first"), kind: "app" as const }
    const queryClient = client()
    const [status, table] = await Promise.all([
      queryClient.fetchQuery(instanceInventoryQueryOptions(ref, "status")),
      queryClient.fetchQuery(instanceInventoryQueryOptions(ref, "table")),
    ])
    expect(status).toMatchObject({
      view: "status",
      data: null,
      observation: { id: "first" },
    })
    expect(table).toMatchObject({
      view: "table",
      data: { containerCount: 2, runningContainerCount: 1 },
      observation: { id: "first" },
    })
  })
  it("resolves simultaneous identities independently from a shared batch", async () => {
    endpoint.read.mockImplementation(
      async ({
        data,
      }: {
        data: Array<InstanceInventoryRequest>
      }): Promise<Array<InstanceInventoryResult>> =>
        data.map((request) =>
          request.reference.id === "missing"
            ? { request, error: "unavailable" }
            : {
                request,
                value: {
                  kind: request.reference.kind,
                  view: "status",
                  data: null,
                  observation: observation(request.reference),
                },
              }
        )
    )
    const queryClient = client()
    const results = await Promise.allSettled(
      ["first", "missing", "second"].map((id) =>
        queryClient.fetchQuery(instanceStateQueryOptions(reference(id)))
      )
    )
    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { observation: { id: "first", runtime: "running" } },
    })
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { message: "Resource unavailable" },
    })
    expect(results[2]).toMatchObject({
      status: "fulfilled",
      value: { observation: { id: "second", runtime: "running" } },
    })
  })

  it("interrupts the transport when its last observer leaves", async () => {
    let started!: () => void
    let aborted!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const abort = new Promise<void>((resolve) => {
      aborted = resolve
    })
    endpoint.read.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted()
              reject(new Error("aborted"))
            },
            { once: true }
          )
          started()
        })
    )
    const observer = new QueryObserver(client(), {
      ...instanceStateQueryOptions(reference("first")),
      enabled: true,
    })
    const unsubscribe = observer.subscribe(() => {})
    await start
    unsubscribe()
    await abort
    expect(observer.getCurrentResult().isSuccess).toBe(false)
  })

  it("keeps a shared batch alive while another identity is still observed", async () => {
    let started!: () => void
    let finish!: (result: Array<InstanceInventoryResult>) => void
    let signal!: AbortSignal
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    endpoint.read.mockImplementation((request: { signal: AbortSignal }) => {
      signal = request.signal
      return new Promise<Array<InstanceInventoryResult>>((resolve) => {
        finish = resolve
        started()
      })
    })
    const queryClient = client()
    const first = new QueryObserver(queryClient, {
      ...instanceStateQueryOptions(reference("first")),
      enabled: true,
    })
    const second = new QueryObserver(queryClient, {
      ...instanceStateQueryOptions(reference("second")),
      enabled: true,
    })
    const unsubscribeFirst = first.subscribe(() => {})
    let ready!: () => void
    const completed = new Promise<void>((resolve) => {
      ready = resolve
    })
    const unsubscribeSecond = second.subscribe((result) => {
      if (result.isSuccess) ready()
    })
    await start
    unsubscribeFirst()
    expect(signal.aborted).toBe(false)
    finish([
      {
        request: { reference: reference("second"), view: "status" },
        value: {
          kind: "database",
          view: "status",
          data: null,
          observation: observation(reference("second")),
        },
      },
    ])
    await completed
    expect(second.getCurrentResult().data?.id).toBe("second")
    unsubscribeSecond()
  })

  it("keeps a confirmed observation through background refreshes but not across mounts", async () => {
    let respond!: () => void
    endpoint.read.mockImplementation(
      async ({ data }: { data: Array<InstanceInventoryRequest> }) => {
        await new Promise<void>((resolve) => {
          respond = resolve
        })
        return data.map((request) => ({
          request,
          value: {
            kind: "database",
            view: "status",
            data: null,
            observation: observation(request.reference),
          },
        }))
      }
    )
    const queryClient = client()
    const options = instanceStateQueryOptions(reference("first"))
    const first = new QueryObserver(queryClient, options)
    const unsubscribeFirst = first.subscribe(() => {})
    try {
      expect(instanceStateFromQuery(first.getCurrentResult()).phase).toBe(
        "checking"
      )
      await vi.waitFor(() => expect(respond).toBeTypeOf("function"))
      respond()
      await vi.waitFor(() =>
        expect(instanceStateFromQuery(first.getCurrentResult()).phase).toBe(
          "ready"
        )
      )
      const confirmed = instanceStateFromQuery(first.getCurrentResult())

      // A poll in flight keeps showing what this observer confirmed.
      void first.refetch()
      expect(first.getCurrentResult().isFetching).toBe(true)
      expect(instanceStateFromQuery(first.getCurrentResult())).toBe(confirmed)

      // A newly mounted observer does not trust the cached observation.
      const second = new QueryObserver(queryClient, options)
      const unsubscribeSecond = second.subscribe(() => {})
      expect(instanceStateFromQuery(second.getCurrentResult()).phase).toBe(
        "checking"
      )
      unsubscribeSecond()
    } finally {
      unsubscribeFirst()
    }
  })

  it("keeps polling an app whose first read failed until it recovers", async () => {
    // Query only schedules polling in a browser.
    environmentManager.setIsServer(() => false)
    vi.useFakeTimers()
    try {
      const ref = { ...reference("first"), kind: "app" as const }
      endpoint.read
        .mockRejectedValueOnce(new Error("Relay timed out"))
        .mockImplementation(
          async ({ data }: { data: Array<InstanceInventoryRequest> }) =>
            data.map((request) => ({
              request,
              value: {
                kind: "app",
                view: "status",
                data: null,
                observation: observation(request.reference),
              },
            }))
        )
      const observer = new QueryObserver(
        client(),
        instanceStateQueryOptions(ref)
      )
      const unsubscribe = observer.subscribe(() => {})
      try {
        await vi.advanceTimersByTimeAsync(100)
        expect(instanceStateFromQuery(observer.getCurrentResult()).phase).toBe(
          "error"
        )
        await vi.advanceTimersByTimeAsync(5_000)
        expect(
          instanceStateFromQuery(observer.getCurrentResult())
        ).toMatchObject({ phase: "ready", observation: { runtime: "running" } })
      } finally {
        unsubscribe()
      }
    } finally {
      vi.useRealTimers()
      environmentManager.setIsServer(() => typeof window === "undefined")
    }
  })
})
