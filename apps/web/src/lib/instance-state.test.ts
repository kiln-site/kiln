import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type {
  InstanceObservation,
  InstanceReference,
  InstanceStateResult,
} from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const endpoint = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/server/instance-states", () => ({
  getInstanceStates: endpoint.read,
}))

import { instanceStateQueryOptions } from "./instance-state"

const reference = (id: string): InstanceReference => ({
  kind: "database",
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
  it("resolves simultaneous identities independently from a shared batch", async () => {
    endpoint.read.mockImplementation(
      async ({
        data,
      }: {
        data: Array<InstanceReference>
      }): Promise<Array<InstanceStateResult>> =>
        data.map((ref) =>
          ref.id === "missing"
            ? { reference: ref, error: "Resource unavailable" }
            : { reference: ref, observation: observation(ref) }
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
      value: { id: "first", runtime: "running" },
    })
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { message: "Resource unavailable" },
    })
    expect(results[2]).toMatchObject({
      status: "fulfilled",
      value: { id: "second", runtime: "running" },
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
    let finish!: (result: Array<InstanceStateResult>) => void
    let signal!: AbortSignal
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    endpoint.read.mockImplementation((request: { signal: AbortSignal }) => {
      signal = request.signal
      return new Promise<Array<InstanceStateResult>>((resolve) => {
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
        reference: reference("second"),
        observation: observation(reference("second")),
      },
    ])
    await completed
    expect(second.getCurrentResult().data?.id).toBe("second")
    unsubscribeSecond()
  })
})
