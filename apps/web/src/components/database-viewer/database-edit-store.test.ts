import { describe, expect, it } from "vite-plus/test"

import { createDatabaseEditStore } from "@/components/database-viewer/database-edit-store"
import { createDatabasePageStore } from "@/components/database-viewer/database-page-store"
import { parseEditedText } from "@/components/database-viewer/database-values"

const row = {
  id: "alex",
  key: { uuid: "a" },
  original: { balance: 10, name: "Alex", uuid: "a" },
}

describe("database edit store", () => {
  it("stages changes against the whole loaded row and drops reverted edits", () => {
    const store = createDatabaseEditStore("players")
    store.setCell(row, "name", "Alexa")
    store.setCell(row, "balance", 12)
    store.setCell(row, "balance", 10)

    expect(store.getPendingCount()).toBe(1)
    expect(store.toChanges()).toEqual([
      {
        kind: "update",
        key: { uuid: "a" },
        original: { balance: 10, name: "Alex", uuid: "a" },
        values: { name: "Alexa" },
      },
    ])
  })

  it("keeps the first snapshot when the row refetches", () => {
    const store = createDatabaseEditStore("players")
    store.setCell(row, "balance", 12)
    // Someone else changes the balance to 11 and the page refetches.
    const refetched = { ...row, original: { ...row.original, balance: 11 } }
    store.setCell(refetched, "name", "Alexa")

    expect(store.toChanges()).toEqual([
      {
        kind: "update",
        key: { uuid: "a" },
        original: row.original,
        values: { balance: 12, name: "Alexa" },
      },
    ])
  })

  it("holds staging while a save is in flight", () => {
    const store = createDatabaseEditStore("players")
    store.setLocked(true)
    store.setCell(row, "name", "Alexa")
    store.toggleDeleted(row)

    expect(store.insertRow()).toBeNull()
    expect(store.getPendingCount()).toBe(0)
  })

  it("sends deletes instead of edits for deleted rows", () => {
    const store = createDatabaseEditStore("players")
    store.setCell(row, "name", "Alexa")
    store.toggleDeleted(row)
    const inserted = store.insertRow() ?? ""
    store.setInsertedCell(inserted, "name", "Steve")

    expect(store.toChanges()).toEqual([
      { kind: "delete", key: { uuid: "a" }, original: row.original },
      { kind: "insert", values: { name: "Steve" } },
    ])
  })

  it("restages a kept change onto the current row after a conflict", () => {
    const store = createDatabaseEditStore("players")
    const steve = { ...row, id: "steve", key: { uuid: "b" } }
    store.setCell(row, "name", "Alexa")
    store.setCell(steve, "name", "Steven")
    // Someone else changed Alex's balance; the user keeps their edit.
    const current = { ...row.original, balance: 11 }
    store.rebase("alex", current)
    // Someone else already renamed Steve the same way; nothing is left.
    store.rebase("steve", { ...steve.original, name: "Steven" })

    expect(store.toChanges()).toEqual([
      {
        kind: "update",
        key: { uuid: "a" },
        original: current,
        values: { name: "Alexa" },
      },
    ])
    store.drop(["alex"])
    expect(store.getPendingCount()).toBe(0)
  })

  it("snapshots every column of a row, not just the visible ones", () => {
    const page = createDatabasePageStore({
      columns: ["uuid", "name", "balance"],
      keys: [{ rowid: 1 }],
      rows: [["a", "Alex", 10]],
    })

    expect(page.getRowSnapshot(0)?.original).toEqual({
      balance: 10,
      name: "Alex",
      uuid: "a",
    })
  })

  it("keeps untouched values typed and converts numeric input", () => {
    expect(parseEditedText("10", 10, { type: "INTEGER" })).toBe(10)
    expect(parseEditedText("42", "old", { type: "INTEGER" })).toBe(42)
    expect(parseEditedText("9007199254740993", 1, { type: "BIGINT" })).toEqual({
      $bigint: "9007199254740993",
    })
    expect(parseEditedText("9007199254740995", 1, { type: "NUMERIC" })).toEqual(
      { $bigint: "9007199254740995" }
    )
    expect(parseEditedText("", null, { type: "TEXT" })).toBeNull()
    expect(parseEditedText("007", "x", { type: "TEXT" })).toBe("007")
  })
})
