import { Cause, Effect } from "effect"

import { CliCommandError, commandError } from "./errors.js"

export function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`)
}

export function writeText(value: string): void {
  process.stdout.write(value)
}

interface RenderedCliError {
  exitCode: number
  output: string
}

function renderErrorCause(
  cause: Cause.Cause<CliCommandError>
): RenderedCliError {
  if (Cause.hasInterruptsOnly(cause)) return { exitCode: 130, output: "" }
  const squashed = Cause.squash(cause)
  const error =
    squashed instanceof CliCommandError
      ? squashed
      : commandError({
          cause: squashed,
          code: "unexpected_error",
          message:
            describeCause(squashed)[0] ?? "An unknown CLI error occurred.",
        })
  const details = describeCause(error.cause).filter(
    (detail) => detail !== error.message
  )
  const lines = [`Error: ${error.message}`, `Code: ${error.code}`]
  if (error.requestId) lines.push(`Request: ${error.requestId}`)
  details.forEach((detail, index) => {
    lines.push(`${index === 0 ? "Cause" : "Caused by"}: ${detail}`)
  })
  if (error.retryable)
    lines.push("Hint: This operation may succeed if retried.")
  return { exitCode: error.exitCode, output: `${lines.join("\n")}\n` }
}

export const reportErrorCauseEffect = Effect.fn("cli.output.error")(function* (
  cause: Cause.Cause<CliCommandError>
) {
  const report = renderErrorCause(cause)
  yield* Effect.sync(() => {
    process.stderr.write(report.output)
    process.exitCode = report.exitCode
  })
})

function describeCause(cause: unknown, depth = 0): Array<string> {
  if (cause === undefined || cause === null || depth >= 5) return []
  if (typeof cause === "object" && "issues" in cause) {
    const issues = describeIssues(cause.issues)
    if (issues.length > 0) return issues
  }
  if (cause instanceof Error) {
    return uniqueDetails([
      normalizeDetail(cause.message || cause.name),
      ...describeCause(cause.cause, depth + 1),
    ])
  }
  if (typeof cause === "object") {
    const message =
      "message" in cause && typeof cause.message === "string"
        ? normalizeDetail(cause.message)
        : ""
    const nested = "cause" in cause ? cause.cause : undefined
    return uniqueDetails([message, ...describeCause(nested, depth + 1)])
  }
  return [normalizeDetail(String(cause))].filter(Boolean)
}

function describeIssues(issues: unknown): Array<string> {
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue) => {
    if (typeof issue !== "object" || issue === null) return []
    const message =
      "message" in issue && typeof issue.message === "string"
        ? normalizeDetail(issue.message)
        : ""
    if (!message) return []
    const path =
      "path" in issue && Array.isArray(issue.path)
        ? issue.path.map(String).join(".")
        : ""
    return [path ? `${path}: ${message}` : message]
  })
}

function normalizeDetail(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

function uniqueDetails(details: Array<string>): Array<string> {
  return [...new Set(details.filter(Boolean))]
}

function renderTable(
  headings: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): string {
  const normalizedRows = [headings, ...rows].map((row) =>
    row.map(normalizeCell)
  )
  const widths = headings.map((_, column) =>
    Math.max(...normalizedRows.map((row) => row[column]?.length ?? 0))
  )
  return normalizedRows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)
        )
        .join("  ")
        .trimEnd()
    )
    .join("\n")
}

export function writeTable(
  headings: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): void {
  writeLine(renderTable(headings, rows))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1_024
  let unit = 0
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024
    unit += 1
  }
  const precision = value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unit]}`
}

function normalizeCell(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ")
}
