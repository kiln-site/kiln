import type { RelayConsoleLine } from "@workspace/contracts"

import { redactSensitiveTextWithRanges } from "@/lib/redaction"

/**
 * Lines as text to save or paste, one per line. Censoring follows the viewer's
 * toggle, since what leaves the page shouldn't show more than the page did.
 */
export function formatConsoleLog(
  lines: ReadonlyArray<RelayConsoleLine>,
  { redact }: { redact: boolean }
): string {
  return lines
    .map((line) => {
      const text = redact
        ? redactSensitiveTextWithRanges(line.text).text
        : line.text
      const time = line.timestamp ?? "-"
      return `${time} ${line.level.toUpperCase().padEnd(5)} ${text}`
    })
    .join("\n")
}

/** `<name>-20261106-142530.log`, in the viewer's time. */
export function consoleLogFilename(name: string, now = new Date()): string {
  const safe = name.replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "log"
  const pad = (value: number) => String(value).padStart(2, "0")
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${safe}-${date}-${time}.log`
}

export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
