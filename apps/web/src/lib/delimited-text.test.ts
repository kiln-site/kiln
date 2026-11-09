import { describe, expect, it } from "vite-plus/test"

import { delimitedTable, MAX_TABLE_COLUMNS } from "@/lib/delimited-text"

describe("delimited text", () => {
  it("leaves a table too wide to show to the source, without building it", () => {
    // A small file whose one long row would pad every other row to its width.
    const text = `${"a,".repeat(MAX_TABLE_COLUMNS * 10)}a\n${"1\n".repeat(10_000)}`

    expect(delimitedTable("wide.csv", text)).toMatchObject({
      columns: MAX_TABLE_COLUMNS * 10 + 1,
      kind: "too-large",
      rows: 10_000,
    })
  })
})
