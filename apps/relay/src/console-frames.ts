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
  return encodeNewestBatch(input, batchEnvelope(input), input.lines.length)
}

// The history frame of the newest lines before `end` that fit in one, and
// where those lines start. Older lines follow in a frame ending there.
export function encodeConsoleHistoryFrame(
  input: Omit<ConsoleBatchInput, "type">,
  end: number
): EncodedConsoleBatch {
  const history = { ...input, type: "history" as const }
  return encodeNewestBatch(history, batchEnvelope(history), end)
}

// About what a line holds in memory, in characters, for budgets on the
// output kept for browsers.
export function consoleLineCharacters(line: RelayConsoleLine): number {
  let characters = line.text.length
  for (const segment of line.segments ?? []) {
    characters += segment.text.length
  }
  return characters
}

export function encodeConsoleLineFrame(line: RelayConsoleLine): string {
  const fitted = fitConsoleLine(line, (candidate) =>
    JSON.stringify({ type: "line", line: candidate })
  )
  return JSON.stringify({ type: "line", line: fitted })
}

// The newest of the lines before `end` that fit in one frame, encoding only
// those, so a whole history encodes in one pass over its lines.
function encodeNewestBatch(
  input: ConsoleBatchInput,
  envelope: BatchEnvelope,
  end: number
): EncodedConsoleBatch {
  let start = end
  const selectedNewestFirst: Array<string> = []
  let selectedBytes = 0

  while (start > 0) {
    const nextStart = start - 1
    const original = input.lines[nextStart]!
    const originalJson = JSON.stringify(original)
    const candidateBytes =
      envelope.prefixBytes +
      selectedBytes +
      Buffer.byteLength(originalJson) +
      selectedNewestFirst.length +
      Buffer.byteLength(envelope.suffix(nextStart))
    if (
      candidateBytes > relayBrowserMaxFrameBytes &&
      selectedNewestFirst.length > 0
    ) {
      break
    }
    const lineJson =
      candidateBytes > relayBrowserMaxFrameBytes
        ? JSON.stringify(
            fitConsoleLine(original, (candidate) =>
              envelope.encode([JSON.stringify(candidate)], nextStart)
            )
          )
        : originalJson
    start = nextStart
    selectedNewestFirst.push(lineJson)
    selectedBytes += Buffer.byteLength(lineJson)
  }

  return {
    encoded: envelope.encode(selectedNewestFirst.reverse(), start),
    start,
  }
}

interface BatchEnvelope {
  readonly encode: (lines: ReadonlyArray<string>, start: number) => string
  readonly prefixBytes: number
  readonly suffix: (start: number) => string
}

function batchEnvelope(input: ConsoleBatchInput): BatchEnvelope {
  const prefix = `{"type":${JSON.stringify(input.type)},"instanceId":${JSON.stringify(input.instanceId)},"lifecycle":${JSON.stringify(input.lifecycle)},"lines":[`
  const suffix = (start: number) =>
    `],"truncated":${input.truncated || start > 0}}`
  return {
    encode: (lines, start) => `${prefix}${lines.join(",")}${suffix(start)}`,
    prefixBytes: Buffer.byteLength(prefix),
    suffix,
  }
}

// Drops a line's styling, then cuts its text, until its encoding fits in a
// browser frame.
export function fitConsoleLine(
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
