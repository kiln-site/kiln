import { describe, expect, it } from "vite-plus/test"

import { formatConsoleLog } from "@/lib/console-export"

const lines = [
  {
    id: "1",
    level: "info" as const,
    text: "client 203.0.113.9 connected",
    timestamp: "2026-11-06T12:00:00.000Z",
  },
]

describe("formatConsoleLog", () => {
  it("doesn't let a censored address out of the page", () => {
    expect(formatConsoleLog(lines, { redact: true })).not.toContain(
      "203.0.113.9"
    )
  })

  it("keeps the address once the viewer shows it", () => {
    expect(formatConsoleLog(lines, { redact: false })).toContain("203.0.113.9")
  })
})
