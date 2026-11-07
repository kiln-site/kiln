import type { RelayConsoleSegment } from "@workspace/contracts"

// Colors plain log text by what it says, for output with no color of its own:
// builds run without a terminal, and most services don't style their logs.
// Output that brought its own colors keeps them.

export type ConsoleTone =
  | "cached"
  | "debug"
  | "done"
  | "error"
  | "hash"
  | "info"
  | "instruction"
  | "key"
  | "measure"
  | "method"
  | "muted"
  | "step"
  | "string"
  | "warn"

export type ConsoleSegment = RelayConsoleSegment & { tone?: ConsoleTone }

interface Token {
  from: number
  to: number
  tone: ConsoleTone
}

// Past this a line is a data dump, not something to read.
const MAX_HIGHLIGHTED_CHARACTERS = 2_000

const HTTP_METHOD = /\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/u

const TOKEN_PATTERN = new RegExp(
  [
    // Consumed so the rest leave a URL whole; the row links it.
    String.raw`(?<url>https?://\S+)`,
    String.raw`(?<time>\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b)`,
    String.raw`(?<error>\b(?:ERROR|ERR|FATAL|CRIT(?:ICAL)?|SEVERE|PANIC)\b|\b(?:error|fatal|panic)(?=:))`,
    String.raw`(?<warn>\bWARN(?:ING)?\b|\bwarn(?:ing)?(?=:))`,
    String.raw`(?<info>\b(?:INFO|NOTICE|LOG)\b|\binfo(?=:))`,
    String.raw`(?<debug>\b(?:DEBUG|TRACE)\b|\b(?:debug|trace)(?=:))`,
    String.raw`(?<method>\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b)`,
    String.raw`(?<hash>\bsha256:[a-f\d]{12,}|\b[a-f\d]{40}\b)`,
    String.raw`(?<string>"(?:[^"\\]|\\.)*"|(?<![\w'])'(?:[^'\\]|\\.)*'(?![\w']))`,
    String.raw`(?<key>\b[A-Za-z_][\w.-]*(?==))`,
    String.raw`(?<measure>\b\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h|[KMGT]i?B|kB|B)(?![\w.])|\b\d+(?:\.\d+)?%)`,
    String.raw`(?<status>(?<=\s)[1-5]\d{2}(?=\s|$))`,
  ].join("|"),
  "gu"
)

// BuildKit's plain progress: `#7 [2/4] RUN npm ci`, `#7 1.204 added 80
// packages`, `#7 DONE 3.1s`, `#7 CACHED`.
const BUILD_STEP_PATTERN =
  /^(#\d+) (?:(\[[^\]]*\]) ([A-Z]+)\b|(DONE [\d.]+s)|(CACHED)|(\d+\.\d+) )?/u

function buildStepTokens(text: string): Array<Token> {
  if (!text.startsWith("#")) return []
  const match = BUILD_STEP_PATTERN.exec(text)
  if (!match) return []
  const [, step, stage, instruction, done, cached, offset] = match
  const tokens: Array<Token> = [{ from: 0, to: step!.length, tone: "muted" }]
  const after = step!.length + 1
  if (stage) {
    tokens.push({ from: after, to: after + stage.length, tone: "step" })
    const start = after + stage.length + 1
    tokens.push({
      from: start,
      to: start + instruction!.length,
      tone: "instruction",
    })
  } else if (done) {
    tokens.push({ from: after, to: after + done.length, tone: "done" })
  } else if (cached) {
    tokens.push({ from: after, to: after + cached.length, tone: "cached" })
  } else if (offset) {
    tokens.push({ from: after, to: after + offset.length, tone: "muted" })
  }
  return tokens
}

function statusTone(status: string): ConsoleTone {
  if (status.startsWith("5")) return "error"
  if (status.startsWith("4")) return "warn"
  if (status.startsWith("3")) return "cached"
  return "done"
}

const GROUP_TONES = {
  debug: "debug",
  error: "error",
  hash: "hash",
  info: "info",
  key: "key",
  measure: "measure",
  method: "method",
  string: "string",
  time: "muted",
  warn: "warn",
} as const satisfies Record<string, ConsoleTone>

function textTokens(text: string, start: number): Array<Token> {
  const http = HTTP_METHOD.test(text)
  const tokens: Array<Token> = []
  const body = text.slice(start, MAX_HIGHLIGHTED_CHARACTERS)
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const groups = match.groups!
    const from = start + match.index
    const to = from + match[0].length
    if (groups.url) continue
    if (groups.status) {
      // A bare number only means a status beside a method.
      if (http) tokens.push({ from, to, tone: statusTone(groups.status) })
      continue
    }
    if (groups.string) {
      // A JSON object's key reads as a key.
      const tone = text[to] === ":" ? "key" : "string"
      tokens.push({ from, to, tone })
      continue
    }
    for (const [group, tone] of Object.entries(GROUP_TONES)) {
      if (groups[group]) {
        tokens.push({ from, to, tone })
        break
      }
    }
  }
  return tokens
}

/** Plain text split into toned segments; null when nothing stands out. */
export function highlightConsoleText(
  text: string
): Array<ConsoleSegment> | null {
  const step = buildStepTokens(text)
  const tokens = [...step, ...textTokens(text, step.at(-1)?.to ?? 0)]
  if (tokens.length === 0) return null
  const segments: Array<ConsoleSegment> = []
  let cursor = 0
  for (const { from, to, tone } of tokens) {
    if (from > cursor) segments.push({ text: text.slice(cursor, from) })
    segments.push({ text: text.slice(from, to), tone })
    cursor = to
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
