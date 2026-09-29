import { describe, expect, it } from "vite-plus/test"

import { createDatabaseEditStore } from "@/components/files/database/database-edit-store"
import { parseEditedText } from "@/components/files/database/database-values"

const row = {
  id: "alex",
  key: { uuid: "a" },
  original: { balance: 10, name: "Alex", uuid: "a" },
}

describe("database edit store", () => {
  it("guards updates with the loaded values and drops edits that revert", () => {
    const store = createDatabaseEditStore("players")
    store.setCell(row, "name", "Alexa")
    store.setCell(row, "balance", 12)
    store.setCell(row, "balance", 10)

    expect(store.getPendingCount()).toBe(1)
    expect(store.toChanges()).toEqual([
      {
        kind: "update",
        key: { uuid: "a" },
        original: { name: "Alex" },
        values: { name: "Alexa" },
      },
    ])
  })

  it("keeps each edit's original value across refetches", () => {
    const store = createDatabaseEditStore("players")
    store.setCell(row, "balance", 12)
    // Someone else changes the balance to 11 and the page refetches.
    const refetched = { ...row, original: { ...row.original, balance: 11 } }
    store.setCell(refetched, "name", "Alexa")

    expect(store.toChanges()).toEqual([
      {
        kind: "update",
        key: { uuid: "a" },
        original: { balance: 10, name: "Alex" },
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
      { kind: "delete", key: { uuid: "a" } },
      { kind: "insert", values: { name: "Steve" } },
    ])
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
