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
    const store = createDatabaseEditStore()
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

  it("sends deletes instead of edits for deleted rows", () => {
    const store = createDatabaseEditStore()
    store.setCell(row, "name", "Alexa")
    store.toggleDeleted(row)
    const inserted = store.insertRow()
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
    expect(parseEditedText("", null, { type: "TEXT" })).toBeNull()
    expect(parseEditedText("007", "x", { type: "TEXT" })).toBe("007")
  })
})
