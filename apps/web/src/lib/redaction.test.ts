import { describe, expect, it } from "vite-plus/test"

import { redactSensitiveTextWithRanges } from "@/lib/redaction"

describe("sensitive text redaction", () => {
  it("tracks only text replaced by Hearth as redacted", () => {
    expect(
      redactSensitiveTextWithRanges("**** server at 192.168.1.10 is offline")
    ).toEqual({
      redactions: [{ from: 15, to: 30 }],
      text: "**** server at ***.***.***.*** is offline",
    })
  })
})
