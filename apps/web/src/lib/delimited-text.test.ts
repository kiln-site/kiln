import { describe, expect, it } from "vite-plus/test"

import {
  delimitedTable,
  MAX_TABLE_COLUMNS,
  parseDelimitedText,
} from "@/lib/delimited-text"

describe("delimited text", () => {
  it("keeps delimiters, line breaks and quotes inside quoted fields", () => {
    expect(
      parseDelimitedText(
        '﻿name,note\r\n"Sam, the builder","said ""hi""\nthen left",\n',
        ","
      )
    ).toEqual([
      ["name", "note"],
      ["Sam, the builder", 'said "hi"\nthen left', ""],
    ])
  })

  it("reads a tall file", () => {
    const table = delimitedTable("tall.csv", `value\n${"1\n".repeat(200_000)}`)

    expect(table.kind === "table" && table.rows.length).toBe(200_000)
  })

  it("leaves a table too wide to show to the source, without building it", () => {
    // A small file whose one long row would pad every other row to its width.
    const text = `${"a,".repeat(MAX_TABLE_COLUMNS * 10)}a\n${"1\n".repeat(10_000)}`

    expect(delimitedTable("wide.csv", text)).toMatchObject({
      columns: MAX_TABLE_COLUMNS * 10 + 1,
      kind: "too-large",
      rows: 10_000,
    })
  })

  it("names every column apart, even past a header that looks generated", () => {
    const table = delimitedTable("named.csv", "id,,id,id (2)\n1,2,3,4")

    expect(table.kind === "table" && table.columns).toEqual([
      "id",
      "Column 2",
      "id (2)",
      "id (2) (2)",
    ])
  })
})
