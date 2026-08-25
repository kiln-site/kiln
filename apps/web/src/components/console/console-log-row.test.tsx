import { renderToStaticMarkup } from "react-dom/server"
import type { RelayConsoleLine } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import { consoleStateLine } from "@/components/console/console-lifecycle"
import { ConsoleLogRow } from "@/components/console/console-log-row"
import { createConsoleUiStore } from "@/components/console/console-stores"

describe("console log row timestamps", () => {
  it("keeps lifecycle timestamps aligned like normal log timestamps", () => {
    const timestamp = "2026-08-24T14:58:50.892572130Z"
    const normalLine: RelayConsoleLine = {
      id: "normal-line",
      level: "info",
      segments: [],
      text: "normal output",
      timestamp,
    }

    const normalTimestampClass = timestampClass(renderRow(normalLine))
    const lifecycleTimestampClass = timestampClass(
      renderRow(consoleStateLine("stopped", timestamp))
    )

    expect(lifecycleTimestampClass).toBe(normalTimestampClass)
    expect(normalTimestampClass).toContain("leading-[18px]")
    expect(lifecycleTimestampClass.split(" ")).toContain("text-left")
  })
})

function renderRow(line: RelayConsoleLine): string {
  return renderToStaticMarkup(
    <ConsoleLogRow
      index={0}
      line={line}
      measureElement={() => undefined}
      query=""
      showTimestamps
      start={0}
      uiStore={createConsoleUiStore()}
      wrapLines={false}
    />
  )
}

function timestampClass(markup: string): string {
  const match = markup.match(/<span class="([^"]*w-\[3\.25rem\][^"]*)">/u)
  expect(match?.[1]).toBeDefined()
  return match?.[1] ?? ""
}
