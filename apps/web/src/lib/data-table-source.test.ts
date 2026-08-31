import { describe, expect, it, vi } from "vite-plus/test"

import {
  replaceDataTableRows,
  resolveCursorDataTableBodyState,
  resolveCursorDataTableNextPageState,
  resolveLiveDataTableBodyState,
  type DataTableSource,
} from "@/lib/data-table-source"

describe("data table sources", () => {
  it("keeps retained cursor rows visible while a query refresh fails", () => {
    expect(
      resolveCursorDataTableBodyState({
        error: new Error("offline"),
        hasData: true,
        isError: true,
        isFetchNextPageError: false,
        isPending: false,
        retry: vi.fn(),
      })
    ).toEqual({ kind: "ready" })
  })

  it("keeps retained live rows visible while loading or errors change", () => {
    const input = {
      error: new Error("offline"),
      isError: true,
      isLoading: true,
      retry: vi.fn(),
      rowCount: 1,
    }

    expect(resolveLiveDataTableBodyState(input)).toEqual({ kind: "ready" })
  })

  it("separates initial cursor failures from next-page failures", () => {
    const error = new Error("offline")
    const retry = vi.fn()

    expect(
      resolveCursorDataTableBodyState({
        error,
        hasData: false,
        isError: true,
        isFetchNextPageError: false,
        isPending: false,
        retry,
      })
    ).toEqual({ error, kind: "error", retry })
    expect(
      resolveCursorDataTableBodyState({
        error,
        hasData: false,
        isError: true,
        isFetchNextPageError: true,
        isPending: false,
        retry,
      })
    ).toEqual({ kind: "ready" })
  })

  it("keeps cursor append failures and refreshes out of the table body", () => {
    const error = new Error("offline")

    expect(
      resolveCursorDataTableNextPageState({
        error,
        isFetchNextPageError: true,
        isFetchingNextPage: false,
        refreshing: false,
      })
    ).toEqual({ error, kind: "error" })
    expect(
      resolveCursorDataTableNextPageState({
        error,
        isFetchNextPageError: true,
        isFetchingNextPage: true,
        refreshing: true,
      })
    ).toEqual({ kind: "idle" })
  })

  it("projects domain feedback rows without losing source state", () => {
    const source: DataTableSource<{ id: string }> = {
      body: { kind: "ready" },
      refreshing: true,
      resetKey: "scope-a",
      rows: [{ id: "a" }],
    }

    expect(replaceDataTableRows(source, [{ name: "A" }])).toEqual({
      body: { kind: "ready" },
      refreshing: true,
      resetKey: "scope-a",
      rows: [{ name: "A" }],
    })
  })
})
