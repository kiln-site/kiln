import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { startBrowserSpan } from "@/lib/browser-telemetry"
import { currentPageOpenSpan } from "@/lib/page-timing"

/** Work a Files page waits on before its content can show. */
export type FileWork =
  | "activity"
  | "database-module"
  | "directory"
  | "editor-module"
  | "entry"
  | "file"
  | "workspace-module"

const spanNames: Record<FileWork, string> = {
  activity: "Files activity read",
  "database-module": "File database viewer module",
  directory: "Files directory read",
  "editor-module": "Code editor module",
  entry: "Files entry read",
  file: "Files file read",
  "workspace-module": "Files workspace module",
}

/**
 * Times work started while a page open is being timed: a read from the
 * Relay through Hearth, or a module load. Each is a `kiln:files:<work>`
 * measure, readable in devtools and by measurement scripts, and a span
 * nested under the open. Work started after the page is ready, such as
 * polling an open file, runs untimed.
 */
export function traceFileWork<TResult>(
  work: FileWork,
  options: {
    readonly attributes?: Record<string, unknown>
    // A read's query signal; reads abandoned through it are cancelled.
    readonly signal?: AbortSignal
    readonly describe?: (result: TResult) => Record<string, unknown>
  },
  run: () => Promise<TResult>
): Promise<TResult> {
  const { attributes = {}, describe, signal } = options
  const parent =
    typeof window === "undefined" ? undefined : currentPageOpenSpan()
  if (!parent) return run()
  const startedAt = performance.now()
  const span = startBrowserSpan(spanNames[work], {
    parent,
    attributes: { "kiln.operation": `ui.files.${work}`, ...attributes },
  })
  const finish = (
    result: "ok" | "error" | "cancelled",
    details: Record<string, unknown>,
    error?: unknown
  ) => {
    const end = performance.now()
    span.setAttribute("kiln.files.result", result)
    for (const [key, value] of Object.entries(details)) {
      span.setAttribute(key, value)
    }
    performance.measure(`kiln:files:${work}`, {
      start: startedAt,
      end,
      detail: { result, ...attributes, ...details },
    })
    span.end(error, end)
  }
  return Effect.runPromise(
    promiseEffect(run).pipe(
      Effect.tap((result) =>
        Effect.sync(() => finish("ok", describe?.(result) ?? {}))
      ),
      Effect.tapError((cause) =>
        Effect.sync(() =>
          signal?.aborted ? finish("cancelled", {}) : finish("error", {}, cause)
        )
      )
    )
  )
}
