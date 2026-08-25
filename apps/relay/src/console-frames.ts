import {
  relayBrowserMaxFrameBytes,
  type RelayInstanceLifecycleEvent,
  type RelayConsoleLine,
} from "@workspace/contracts"

type ConsoleBatchType = "history" | "reset"

interface ConsoleBatchInput {
  instanceId: string
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>
  lines: ReadonlyArray<RelayConsoleLine>
  truncated: boolean
  type: ConsoleBatchType
}

export interface EncodedConsoleBatch {
  encoded: string
  start: number
}

const TRUNCATED_LINE_SUFFIX = "… [line truncated]"

export function encodeNewestConsoleBatch(
  input: ConsoleBatchInput
): EncodedConsoleBatch {
  let start = input.lines.length
  const selectedNewestFirst: Array<string> = []
  let selectedBytes = 0

  while (start > 0) {
    const nextStart = start - 1
    const original = input.lines[nextStart]
    const originalJson = JSON.stringify(original)
    const originalBytes = Buffer.byteLength(originalJson)
    const candidateBytes = batchByteLength(
      input,
      nextStart,
      selectedBytes + originalBytes,
      selectedNewestFirst.length + 1
    )
    if (
      candidateBytes > relayBrowserMaxFrameBytes &&
      selectedNewestFirst.length > 0
    ) {
      break
    }
    const line =
      candidateBytes > relayBrowserMaxFrameBytes
        ? fitConsoleLine(original, (candidate) =>
            encodeBatch(input, [JSON.stringify(candidate)], nextStart)
          )
        : original
    const lineJson = JSON.stringify(line)
    start = nextStart
    selectedNewestFirst.push(lineJson)
    selectedBytes += Buffer.byteLength(lineJson)
  }

  return {
    encoded: encodeBatch(input, [...selectedNewestFirst].reverse(), start),
    start,
  }
}

export function encodeConsoleHistoryFrames(
  input: Omit<ConsoleBatchInput, "type">
): Array<string> {
  const frames: Array<string> = []
  let end = input.lines.length
  while (end > 0) {
    const batch = encodeNewestConsoleBatch({
      ...input,
      lines: input.lines.slice(0, end),
      type: "history",
    })
    frames.push(batch.encoded)
    if (batch.start >= end) {
      throw new Error("Could not fit a console line in a browser frame")
    }
    end = batch.start
  }
  return frames
}

export function encodeConsoleLineFrame(line: RelayConsoleLine): string {
  const fitted = fitConsoleLine(line, (candidate) =>
    JSON.stringify({ type: "line", line: candidate })
  )
  return JSON.stringify({ type: "line", line: fitted })
}

function encodeBatch(
  input: ConsoleBatchInput,
  encodedLines: ReadonlyArray<string>,
  start: number
): string {
  const [prefix, suffix] = batchEnvelope(input, start)
  return `${prefix}${encodedLines.join(",")}${suffix}`
}

function batchByteLength(
  input: ConsoleBatchInput,
  start: number,
  encodedLineBytes: number,
  lineCount: number
): number {
  const [prefix, suffix] = batchEnvelope(input, start)
  return (
    Buffer.byteLength(prefix) +
    encodedLineBytes +
    Math.max(0, lineCount - 1) +
    Buffer.byteLength(suffix)
  )
}

function batchEnvelope(
  input: ConsoleBatchInput,
  start: number
): [prefix: string, suffix: string] {
  return [
    `{"type":${JSON.stringify(input.type)},"instanceId":${JSON.stringify(input.instanceId)},"lifecycle":${JSON.stringify(input.lifecycle)},"lines":[`,
    `],"truncated":${input.truncated || start > 0}}`,
  ]
}

function fitConsoleLine(
  line: RelayConsoleLine,
  encode: (candidate: RelayConsoleLine) => string
): RelayConsoleLine {
  if (Buffer.byteLength(encode(line)) <= relayBrowserMaxFrameBytes) return line

  const plain = { ...line, segments: undefined }
  if (Buffer.byteLength(encode(plain)) <= relayBrowserMaxFrameBytes)
    return plain

  let low = 0
  let high = line.text.length
  let fitted = { ...plain, text: TRUNCATED_LINE_SUFFIX }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = {
      ...plain,
      text: `${line.text.slice(0, middle)}${TRUNCATED_LINE_SUFFIX}`,
    }
    if (Buffer.byteLength(encode(candidate)) <= relayBrowserMaxFrameBytes) {
      fitted = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return fitted
}
