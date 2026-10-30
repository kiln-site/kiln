import { describe, expect, it } from "vite-plus/test"

import { createDatabaseEditStore } from "@/components/database-viewer/database-edit-store"
import { createDatabasePageStore } from "@/components/database-viewer/database-page-store"

const row = {
  id: "alex",
  key: { uuid: "a" },
  original: { balance: 10, name: "Alex", uuid: "a" },
}

describe("database edit store", () => {
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
})
