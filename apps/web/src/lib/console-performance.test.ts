import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

const sentry = vi.hoisted(() => {
  const spans: Array<{
    attributes: Record<string, unknown>
    end: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
    setAttribute: ReturnType<typeof vi.fn>
  }> = []
  return {
    spans,
    startInactiveSpan: vi.fn((options: Record<string, unknown>) => {
      const attributes: Record<string, unknown> = {}
      const span = {
        attributes,
        end: vi.fn(),
        options,
        setAttribute: vi.fn((name: string, value: unknown) => {
          attributes[name] = value
        }),
      }
      spans.push(span)
      return span
    }),
  }
})

vi.mock("@sentry/tanstackstart-react", () => ({
  startInactiveSpan: sentry.startInactiveSpan,
}))

import {
  createConsoleLoadTiming,
  startConsoleTimingSpan,
} from "./console-performance"

describe("console load timing", () => {
  beforeEach(() => {
    sentry.spans.length = 0
    sentry.startInactiveSpan.mockClear()
  })

  it("keeps retry spans attached until a later attempt becomes ready", () => {
    const timing = createConsoleLoadTiming()

    timing.markRetryableFailure(new Error("Relay is unavailable"))
    const open = sentry.spans[0]
    const rows = sentry.spans[1]
    expect(open?.end).not.toHaveBeenCalled()
    expect(rows?.end).not.toHaveBeenCalled()

    const retry = startConsoleTimingSpan(
      timing,
      "Issue console capability",
      "http.console.capability"
    )
    expect(sentry.spans[2]?.options.parentSpan).toBe(open)
    retry.end()

    timing.markRetryableFailure(new Error("Unable to connect"))
    timing.markReady("hearth", 3)
    expect(open?.attributes).toMatchObject({
      "kiln.console.last_error": "Error",
      "kiln.console.line_count": 3,
      "kiln.console.result": "ready",
      "kiln.console.retry_count": 2,
      "kiln.console.transport": "hearth",
    })
    expect(open?.end).not.toHaveBeenCalled()

    timing.markFirstRowsPainted(3)
    expect(rows?.end).toHaveBeenCalledOnce()
    expect(open?.end).toHaveBeenCalledOnce()
  })
})
