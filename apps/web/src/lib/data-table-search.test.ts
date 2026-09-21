import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createDataTableSearchStore,
  filterDataTableRows,
  replaceDataTableUrlSearch,
} from "@/lib/data-table-search"

describe("data table search", () => {
  it("normalizes the store once and skips no-op notifications", () => {
    const store = createDataTableSearchStore("  Relay One ")
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.getNormalizedSnapshot()).toBe("relay one")
    store.set("  Relay One ")
    expect(listener).not.toHaveBeenCalled()

    store.set("Relay Two")
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getNormalizedSnapshot()).toBe("relay two")
  })

  it("searches explicit fields and caches immutable row text", () => {
    const getName = vi.fn((row: { name: string; relay: string }) => row.name)
    const getRelay = vi.fn((row: { name: string; relay: string }) => row.relay)
    const rows = [{ name: "Survival", relay: "Relay One" }]
    const definition = { fields: [getName, getRelay] }
    const cache = new WeakMap<(typeof rows)[number], string>()

    expect(filterDataTableRows(rows, "relay one", definition, cache)).toEqual(
      rows
    )
    expect(filterDataTableRows(rows, "survival", definition, cache)).toEqual(
      rows
    )
    expect(getName).toHaveBeenCalledOnce()
    expect(getRelay).toHaveBeenCalledOnce()
  })

  it("returns the source array unchanged when search is empty", () => {
    const rows = [{ name: "Survival" }]

    expect(
      filterDataTableRows(
        rows,
        "",
        { fields: [(row) => row.name] },
        new WeakMap()
      )
    ).toBe(rows)
  })
})

describe("replaceDataTableUrlSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("writes the last value once and skips stale pathnames", () => {
    vi.useFakeTimers()
    const replaceState = vi.fn()
    const location = {
      href: "https://kiln.test/infra/servers",
      pathname: "/infra/servers",
    }
    vi.stubGlobal("History", { prototype: { replaceState } })
    vi.stubGlobal("window", { history: { state: null }, location })

    replaceDataTableUrlSearch("s")
    replaceDataTableUrlSearch("su")
    replaceDataTableUrlSearch("survival")
    vi.runAllTimers()

    expect(replaceState).toHaveBeenCalledOnce()
    expect(replaceState.mock.calls[0]?.[2]).toBe(
      "/infra/servers?search=survival"
    )

    replaceDataTableUrlSearch("ignored")
    location.pathname = "/infra/databases"
    vi.runAllTimers()

    expect(replaceState).toHaveBeenCalledOnce()
  })
})
