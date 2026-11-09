import { describe, expect, it } from "vite-plus/test"

import { parseEditedText } from "@/components/database-viewer/database-values"

describe("edited database values", () => {
  it.each(["numeric(30,15)", "decimal(30,15)", "NUMERIC"])(
    "keeps every digit of a %s edit",
    (type) => {
      expect(parseEditedText("1234567890.123456789", "1.5", { type })).toBe(
        "1234567890.123456789"
      )
    }
  )

  it("keeps integers past 2^53 exact", () => {
    expect(parseEditedText("9007199254740993", 1, { type: "BIGINT" })).toEqual({
      $bigint: "9007199254740993",
    })
    expect(parseEditedText("9007199254740995", 1, { type: "NUMERIC" })).toEqual(
      { $bigint: "9007199254740995" }
    )
  })
})
