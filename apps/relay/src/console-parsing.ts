/**
 * Parsing for untrusted container console output: Docker log lines, ANSI and
 * Minecraft styling, terminal-only frames, and tab-completion echoes.
 */
import type {
  RelayConsoleCompletion,
  RelayConsoleLevel,
  RelayConsoleSegment,
} from "@workspace/contracts"

// Docker TTY logs contain ANSI/control bytes. Cursor-editing frames are removed,
// while SGR color and emphasis are retained as safe, structured segments.
/* eslint-disable no-control-regex */
const ANSI_PATTERN = new RegExp(
  "\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)|[=>])",
  "gu"
)
const CONTROL_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]",
  "gu"
)
const TERMINAL_EDIT_PATTERN = new RegExp(
  "(?:\\u0008|\\u001b\\[[0-?]*[ -/]*[ABCDEFGHJKSTfhl])",
  "u"
)
const MINECRAFT_STYLE_PATTERN = /§x(?:§[\da-f]){6}|§[0-9a-fk-or]/giu
const MINECRAFT_LOG_PREFIX_PATTERN =
  /\[\d{2}:\d{2}:\d{2} (?:INFO|WARN(?:ING)?|ERROR|FATAL|SEVERE|DEBUG|TRACE)\]:/iu
const CURL_PROGRESS_HEADER_PATTERN =
  /^\s*%\s+Total\s+%\s+Received\s+%\s+Xferd\s+Average\s+Speed\s+Time\s+Time\s+Time\s+Current\s*$/iu
const CURL_PROGRESS_ROW_PATTERN =
  /^\s*\d+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(?:--:--:--|\d+:\d{2}:\d{2})\s+(?:--:--:--|\d+:\d{2}:\d{2})\s+(?:--:--:--|\d+:\d{2}:\d{2})\s+\S+\s*$/u
/* eslint-enable no-control-regex */

export interface ParsedConsoleLine {
  level: RelayConsoleLevel
  segments?: Array<RelayConsoleSegment>
  service?: "coredns" | "tailscale"
  text: string
  timestamp: string | null
}

export function matchingReadyLogLine(
  lines: ReadonlyArray<ParsedConsoleLine>,
  fragments: ReadonlyArray<string>
): ParsedConsoleLine | undefined {
  return lines.find((line) =>
    fragments.some((fragment) => line.text.includes(fragment))
  )
}

export function parseConsoleLine(value: string): ParsedConsoleLine | null {
  if (isTerminalOnlyConsoleFrame(value)) return null
  const normalized = stripConsoleFormatting(value)
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2}T\S+Z)\s(.*)$/u)
  const timestamp = match?.[1] ?? null
  const text = (match?.[2] ?? normalized)
    .replace(/(?:>\.\.\.\.|…)+/gu, "")
    .replace(CONTROL_PATTERN, "")
    .trim()
    .replace(/^[>=]+\s*(?=\[\d{2}:\d{2}:\d{2})/u, "")
  if (!text || text === "list") return null

  let level: RelayConsoleLevel = "info"
  if (/\b(?:ERROR|FATAL|SEVERE)\b/iu.test(text)) level = "error"
  else if (/\bWARN(?:ING)?\b/iu.test(text)) level = "warn"
  else if (/\bDEBUG\b/iu.test(text)) level = "debug"
  else if (/\bTRACE\b/iu.test(text)) level = "trace"

  const rawText = value.replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s/u, "")
  const segments = styledConsoleSegments(rawText, text)
  return {
    timestamp,
    text,
    level,
    ...(segments ? { segments } : {}),
  }
}

function isTerminalOnlyConsoleFrame(value: string): boolean {
  const normalized = stripConsoleFormatting(value)
  const withoutTimestamp = normalized.replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s*/u, "")
  if (
    CURL_PROGRESS_HEADER_PATTERN.test(withoutTimestamp) ||
    CURL_PROGRESS_ROW_PATTERN.test(withoutTimestamp)
  ) {
    return true
  }
  if (MINECRAFT_LOG_PREFIX_PATTERN.test(normalized)) return false
  const terminalText = normalized
    .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s*/u, "")
    .trimStart()
  if (/^>\s*/u.test(terminalText)) return true
  if (TERMINAL_EDIT_PATTERN.test(value)) return true

  const ansiSequenceCount = value.match(ANSI_PATTERN)?.length ?? 0
  if (ansiSequenceCount >= 4 && /\S+\s{2,}\S+/u.test(normalized)) return true

  const terminalColumns = normalized
    .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s*/u, "")
    .trim()
    .split(/\s{2,}/u)
  return (
    terminalColumns.length >= 2 &&
    terminalColumns.every((column) => /^[a-z0-9_:.?+/-]+$/iu.test(column))
  )
}

export function parseConsoleOutput(result: {
  stdout: string
  stderr: string
}): Array<ParsedConsoleLine> {
  return [result.stdout, result.stderr]
    .flatMap((output) => output.split("\n"))
    .map(parseConsoleLine)
    .filter((line): line is ParsedConsoleLine => line !== null)
    .sort((left, right) =>
      (left.timestamp ?? "").localeCompare(right.timestamp ?? "")
    )
}

interface ConsoleStyle {
  bold: boolean
  color: string | undefined
  italic: boolean
  underline: boolean
}

const ANSI_COLORS = [
  "#1f2937",
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#2563eb",
  "#c026d3",
  "#0891b2",
  "#d1d5db",
  "#6b7280",
  "#f87171",
  "#4ade80",
  "#facc15",
  "#60a5fa",
  "#e879f9",
  "#22d3ee",
  "#f9fafb",
]

const MINECRAFT_COLORS: Readonly<Record<string, string>> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff",
}

function styledConsoleSegments(
  value: string,
  expectedText: string
): Array<RelayConsoleSegment> | undefined {
  const tokenPattern = new RegExp(
    `${String.fromCodePoint(27)}\\[([\\d;:]*)m|§x((?:§[\\da-f]){6})|§([0-9a-fk-or])`,
    "giu"
  )
  const segments: Array<RelayConsoleSegment> = []
  const style: ConsoleStyle = {
    bold: false,
    color: undefined,
    italic: false,
    underline: false,
  }
  let offset = 0
  let styled = false

  const append = (text: string) => {
    const visible = text.replace(CONTROL_PATTERN, "").replace(/\r/gu, "")
    if (!visible) return
    const segment: RelayConsoleSegment = {
      text: visible,
      ...(style.color ? { color: style.color } : {}),
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ? { underline: true } : {}),
    }
    const previous = segments.at(-1)
    if (
      previous &&
      previous.color === segment.color &&
      previous.bold === segment.bold &&
      previous.italic === segment.italic &&
      previous.underline === segment.underline
    ) {
      previous.text += segment.text
    } else {
      segments.push(segment)
    }
  }

  for (const match of value.matchAll(tokenPattern)) {
    append(value.slice(offset, match.index))
    offset = match.index + match[0].length
    styled = true
    if (match[3]) applyMinecraftStyle(match[3].toLowerCase(), style)
    else if (match[2]) applyMinecraftHexStyle(match[2], style)
    else applyAnsiStyle(match[1] ?? "", style)
  }
  append(value.slice(offset))
  if (!styled) return undefined

  const plain = segments.map((segment) => segment.text).join("")
  const start = plain.indexOf(expectedText)
  if (start < 0) return undefined
  return sliceConsoleSegments(segments, start, expectedText.length)
}

function applyMinecraftHexStyle(value: string, style: ConsoleStyle): void {
  resetConsoleStyle(style)
  style.color = `#${value.replaceAll("§", "")}`
}

function applyMinecraftStyle(code: string, style: ConsoleStyle): void {
  const color = MINECRAFT_COLORS[code]
  if (color) {
    resetConsoleStyle(style)
    style.color = color
    return
  }
  if (code === "l") style.bold = true
  else if (code === "m") style.underline = true
  else if (code === "n") style.underline = true
  else if (code === "o") style.italic = true
  else if (code === "r") resetConsoleStyle(style)
}

function applyAnsiStyle(value: string, style: ConsoleStyle): void {
  const parameters = (value ? value.split(/[;:]/u) : ["0"]).map(Number)
  for (let index = 0; index < parameters.length; index++) {
    const code = parameters[index] ?? 0
    if (code === 0) resetConsoleStyle(style)
    else if (code === 1) style.bold = true
    else if (code === 3) style.italic = true
    else if (code === 4) style.underline = true
    else if (code === 22) style.bold = false
    else if (code === 23) style.italic = false
    else if (code === 24) style.underline = false
    else if (code >= 30 && code <= 37) style.color = ANSI_COLORS[code - 30]
    else if (code >= 90 && code <= 97) style.color = ANSI_COLORS[code - 82]
    else if (code === 39) style.color = undefined
    else if (code === 38 && parameters[index + 1] === 5) {
      const paletteIndex = parameters[index + 2]
      if (paletteIndex !== undefined) style.color = ansi256Color(paletteIndex)
      index += 2
    } else if (code === 38 && parameters[index + 1] === 2) {
      const red = parameters[index + 2]
      const green = parameters[index + 3]
      const blue = parameters[index + 4]
      if (red !== undefined && green !== undefined && blue !== undefined) {
        style.color = rgbHex(red, green, blue)
      }
      index += 4
    }
  }
}

function resetConsoleStyle(style: ConsoleStyle): void {
  style.bold = false
  style.color = undefined
  style.italic = false
  style.underline = false
}

function ansi256Color(index: number): string {
  const bounded = Math.max(0, Math.min(255, Math.trunc(index)))
  if (bounded < 16) return ANSI_COLORS[bounded] ?? "#f9fafb"
  if (bounded >= 232) {
    const gray = 8 + (bounded - 232) * 10
    return rgbHex(gray, gray, gray)
  }
  const cube = bounded - 16
  const red = Math.floor(cube / 36)
  const green = Math.floor((cube % 36) / 6)
  const blue = cube % 6
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40)
  return rgbHex(channel(red), channel(green), channel(blue))
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) =>
      Math.max(0, Math.min(255, Math.trunc(value)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`
}

function sliceConsoleSegments(
  segments: ReadonlyArray<RelayConsoleSegment>,
  start: number,
  length: number
): Array<RelayConsoleSegment> {
  const sliced: Array<RelayConsoleSegment> = []
  const end = start + length
  let offset = 0
  for (const segment of segments) {
    const segmentEnd = offset + segment.text.length
    const overlapStart = Math.max(start, offset)
    const overlapEnd = Math.min(end, segmentEnd)
    if (overlapStart < overlapEnd) {
      sliced.push({
        ...segment,
        text: segment.text.slice(overlapStart - offset, overlapEnd - offset),
      })
    }
    offset = segmentEnd
    if (offset >= end) break
  }
  return sliced
}

export function parseConsoleCompletion(
  prefix: string,
  output: string
): Pick<RelayConsoleCompletion, "completedPrefix" | "suggestions"> {
  if (output.includes("\n")) {
    const suggestions = output
      .split(/\r*\n/gu)
      .slice(1)
      .flatMap((line) =>
        stripAnsi(line)
          .replace(CONTROL_PATTERN, "")
          .trim()
          .split(/\s{2,}/gu)
      )
      .map((suggestion) => suggestion.trim())
      .filter(
        (suggestion) =>
          suggestion.length > 0 &&
          suggestion !== prefix &&
          !MINECRAFT_LOG_PREFIX_PATTERN.test(suggestion)
      )
      .filter(
        (suggestion, index, values) => values.indexOf(suggestion) === index
      )
      .slice(0, 100)
    return { completedPrefix: null, suggestions }
  }

  if (output.includes("\u0007")) {
    return { completedPrefix: null, suggestions: [] }
  }

  const rendered = renderTerminalLine(output).trimEnd()
  const afterLastBackspace = stripAnsi(
    output.slice(output.lastIndexOf("\b") + 1)
  )
    .replace(CONTROL_PATTERN, "")
    .trim()
  const tokenStart = Math.max(prefix.lastIndexOf(" ") + 1, 0)
  const typedToken = prefix.slice(tokenStart)
  const completedToken =
    afterLastBackspace.startsWith(typedToken) &&
    afterLastBackspace !== typedToken
      ? `${prefix.slice(0, tokenStart)}${afterLastBackspace}`
      : null
  const completedPrefix =
    completedToken ??
    (afterLastBackspace.startsWith(prefix) && afterLastBackspace !== prefix
      ? afterLastBackspace
      : rendered.startsWith(prefix) && rendered !== prefix
        ? rendered
        : null)
  return { completedPrefix, suggestions: [] }
}

function renderTerminalLine(value: string): string {
  const visible = value.replace(ANSI_PATTERN, "")
  const cells: Array<string> = []
  let cursor = 0
  for (const character of visible) {
    if (character === "\r") {
      cursor = 0
      continue
    }
    if (character === "\b") {
      cursor = Math.max(0, cursor - 1)
      continue
    }
    if (character === "\n") {
      cells.length = 0
      cursor = 0
      continue
    }
    const codePoint = character.charCodeAt(0)
    if (
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 12) ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      continue
    }
    cells[cursor] = character
    cursor += 1
  }
  return cells.join("")
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\r/gu, "")
}

function stripConsoleFormatting(value: string): string {
  return stripAnsi(value).replace(MINECRAFT_STYLE_PATTERN, "")
}
