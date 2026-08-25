import { describe, expect, it } from "vite-plus/test"

import { relayBrowserMaxFrameBytes } from "@workspace/contracts"

import {
  encodeConsoleHistoryFrames,
  encodeConsoleLineFrame,
} from "./console-frames.js"

describe("console browser frames", () => {
  it("chunks history by encoded byte size under the proxy limit", () => {
    const lines = Array.from({ length: 200 }, (_, index) => ({
      id: `line-${index}`,
      level: "info" as const,
      text: `${index}: ${"x".repeat(1_300)}`,
      timestamp: "2026-07-25T17:59:03.123456789Z",
    }))
    const frames = encodeConsoleHistoryFrames({
      instanceId: "instance",
      lifecycle: [{ state: "started", time: "2026-07-25T17:59:03.123456789Z" }],
      lines,
      truncated: false,
    })

    expect(frames.length).toBeGreaterThan(1)
    expect(
      frames.every(
        (frame) => Buffer.byteLength(frame) <= relayBrowserMaxFrameBytes
      )
    ).toBe(true)
    const frameLineIds = frames.map((frame) => {
      const payload = JSON.parse(frame) as {
        lines: Array<{ id: string }>
      }
      return payload.lines.map((line) => line.id)
    })
    expect(frameLineIds[0]?.at(-1)).toBe(lines.at(-1)?.id)
    expect(new Set(frameLineIds.flat())).toEqual(
      new Set(lines.map((line) => line.id))
    )
  })

  it("bounds a single unusually large line", () => {
    const frame = encodeConsoleLineFrame({
      id: "large-line",
      level: "info",
      text: "界".repeat(relayBrowserMaxFrameBytes),
      timestamp: null,
    })

    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(
      relayBrowserMaxFrameBytes
    )
    expect(frame).toContain("[line truncated]")
  })
})
