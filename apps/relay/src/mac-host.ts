import type { RelayDesktopMonitor } from "@workspace/contracts"
import { Result } from "effect"

// What a Relay in Docker on a Mac can learn about the Mac, from the Mac's files
// its VM can see. Screen Sharing says neither: it serves every display as one
// image, and names no accounts. Both are conveniences, so a Mac whose files
// aren't there, or a future format, leaves them empty rather than failing.

const MAX_PLIST_BYTES = 1024 * 1024
const MAX_OBJECTS = 200_000
const MAX_DEPTH = 32
const MAX_DECODED_BYTES = 4 * MAX_PLIST_BYTES
const BYTES_PER_REFERENCE = 8
const MAX_LAYOUTS = 64
const MAX_MONITORS = 16
const MAX_ACCOUNTS = 32
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const NOT_ACCOUNTS = new Set(["Guest", "Shared"])

// OrbStack shows the Mac's paths as they are; Docker Desktop under /host_mnt.
export const MAC_HOST_SCRIPT = String.raw`set -u
for root in "" /host_mnt; do
  file="$root/Library/Preferences/com.apple.windowserver.displays.plist"
  if [ -f "$file" ]; then printf 'displays='; base64 "$file" | tr -d '\n'; echo; break; fi
done
for root in "" /host_mnt; do
  if [ -d "$root/Users" ]; then printf 'accounts='; ls -1 "$root/Users" | tr '\n' ' '; echo; break; fi
done
exit 0`

export interface MacHost {
  readonly accounts: ReadonlyArray<string>
  readonly layouts: ReadonlyArray<ReadonlyArray<RelayDesktopMonitor>>
}

export function parseMacHost(output: string): MacHost {
  const field = (name: string) =>
    output
      .split("\n")
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  return {
    accounts: field("accounts")
      .split(" ")
      .filter((name) => ACCOUNT_PATTERN.test(name))
      .filter((name) => !NOT_ACCOUNTS.has(name))
      .slice(0, MAX_ACCOUNTS),
    layouts: displayLayouts(field("displays")),
  }
}

// The window server keeps every arrangement this Mac has had, so the page
// takes the one that fits the image Screen Sharing sends.
function displayLayouts(encoded: string) {
  const plist = Buffer.from(encoded, "base64")
  if (plist.length > MAX_PLIST_BYTES) return []
  const root = readBinaryPlist(plist)
  const configs = entry(entry(root, "DisplayAnyUserSets"), "Configs")
  if (!Array.isArray(configs)) return []
  const layouts: Array<Array<RelayDesktopMonitor>> = []
  for (const config of configs) {
    const layout = monitorLayout(entry(config, "DisplayConfig") ?? config)
    if (layout && layouts.length < MAX_LAYOUTS) layouts.push(layout)
  }
  return layouts
}

function monitorLayout(displays: unknown) {
  if (!Array.isArray(displays)) return null
  if (displays.length < 2 || displays.length > MAX_MONITORS) return null
  const rectangles = []
  for (const display of displays) {
    const info = entry(display, "CurrentInfo") ?? display
    const scale = entry(info, "Scale")
    const [x, y, width, height] = ["OriginX", "OriginY", "Wide", "High"].map(
      (name) => entry(info, name)
    )
    if (
      !isCoordinate(x) ||
      !isCoordinate(y) ||
      !isCoordinate(width) ||
      !isCoordinate(height) ||
      typeof scale !== "number" ||
      scale < 1 ||
      scale > 4
    ) {
      return null
    }
    rectangles.push({ height, scale, width, x, y })
  }
  const lefts = pixelStarts(
    rectangles.map(({ scale, width, x }) => ({ scale, size: width, start: x }))
  )
  const tops = pixelStarts(
    rectangles.map(({ height, scale, y }) => ({
      scale,
      size: height,
      start: y,
    }))
  )
  return rectangles.map(({ height, scale, width }, index) => ({
    height: height * scale,
    width: width * scale,
    x: lefts[index] ?? 0,
    y: tops[index] ?? 0,
  }))
}

// Origins are in points, relative to the main display, so they can be
// negative, and the image sets displays edge to edge in pixels. Beside a
// display of another scale, a point is a different number of pixels, so each
// display starts where the ones wholly before it end.
function pixelStarts(
  spans: ReadonlyArray<{ scale: number; size: number; start: number }>
) {
  const first = Math.min(...spans.map(({ start }) => start))
  const placed: Array<{ end: number; points: number }> = []
  const starts = new Map<(typeof spans)[number], number>()
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const ends = placed
      .filter(({ points }) => points <= span.start)
      .map(({ end }) => end)
    const pixels =
      ends.length > 0 ? Math.max(...ends) : (span.start - first) * span.scale
    starts.set(span, pixels)
    placed.push({
      end: pixels + span.size * span.scale,
      points: span.start + span.size,
    })
  }
  return spans.map((span) => starts.get(span))
}

const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const entry = (value: unknown, key: string): unknown =>
  value instanceof Map ? value.get(key) : undefined

// Apple's binary property list: enough of it for numbers, strings, arrays, and
// dictionaries. Anything else reads as null. It's the Mac's file, read through
// a VM, so offsets and sizes are checked rather than trusted.
function readBinaryPlist(data: Buffer): unknown {
  if (data.length < 40 || data.toString("latin1", 0, 6) !== "bplist") {
    return null
  }
  const trailer = data.length - 32
  const offsetSize = data.readUInt8(trailer + 6)
  const referenceSize = data.readUInt8(trailer + 7)
  const count = Number(data.readBigUInt64BE(trailer + 8))
  const top = Number(data.readBigUInt64BE(trailer + 16))
  const table = Number(data.readBigUInt64BE(trailer + 24))
  if (
    offsetSize < 1 ||
    offsetSize > 8 ||
    referenceSize < 1 ||
    referenceSize > 8 ||
    count > MAX_OBJECTS ||
    top >= count ||
    table + count * offsetSize > trailer
  ) {
    return null
  }
  const readSized = (at: number, size: number) => {
    if (at < 0 || at + size > trailer) throw new RangeError("Outside the file")
    let value = 0
    for (let index = 0; index < size; index += 1) {
      value = value * 256 + data.readUInt8(at + index)
    }
    return value
  }
  let budget = MAX_OBJECTS
  // What decoding has cost, whatever the file says: its offsets can point many
  // objects at the same bytes.
  let decodedBytes = 0
  const charge = (bytes: number) => {
    decodedBytes += bytes
    if (decodedBytes > MAX_DECODED_BYTES) throw new RangeError("Too much data")
  }
  // An object is decoded once, however often it's referred to, so a small
  // file can't ask for a large string thousands of times over.
  const decoded = new Map<number, unknown>()
  const read = (index: number, depth: number): unknown => {
    if (decoded.has(index)) return decoded.get(index)
    budget -= 1
    if (index >= count || depth > MAX_DEPTH || budget < 0) {
      throw new RangeError("Not a property list Kiln can read")
    }
    const value = decode(index, depth)
    decoded.set(index, value)
    return value
  }
  const decode = (index: number, depth: number): unknown => {
    const at = readSized(table + index * offsetSize, offsetSize)
    const marker = readSized(at, 1)
    const kind = marker >> 4
    const low = marker & 0x0f
    if (kind === 0x1) {
      const size = 1 << low
      if (size !== 8) return size > 6 ? null : readSized(at + 1, size)
      // Only eight-byte integers are signed, as origins left of the main
      // display are.
      const value = Number(data.readBigInt64BE(checked(at + 1, 8)))
      return Number.isSafeInteger(value) ? value : null
    }
    if (kind === 0x2) {
      if (low === 2) return data.readFloatBE(checked(at + 1, 4))
      return low === 3 ? data.readDoubleBE(checked(at + 1, 8)) : null
    }
    if (![0x5, 0x6, 0xa, 0xd].includes(kind)) return null
    let length = low
    let start = at + 1
    if (low === 0x0f) {
      const size = 1 << (readSized(start, 1) & 0x0f)
      if (size > 6) return null
      length = readSized(start + 1, size)
      start += 1 + size
    }
    if (kind === 0x5) {
      charge(length * 2)
      return data.toString("latin1", checked(start, length), start + length)
    }
    if (kind === 0x6) {
      charge(length * 2)
      const bytes = data.subarray(
        checked(start, length * 2),
        start + length * 2
      )
      return Buffer.from(bytes).swap16().toString("utf16le")
    }
    // Before reserving anything for a length the file only claims.
    const references = kind === 0xd ? length * 2 : length
    if (references > budget) throw new RangeError("Too many objects")
    checked(start, references * referenceSize)
    charge(references * BYTES_PER_REFERENCE)
    const reference = (position: number) =>
      readSized(start + position * referenceSize, referenceSize)
    if (kind === 0xa) {
      return Array.from({ length }, (_, position) =>
        read(reference(position), depth + 1)
      )
    }
    const dictionary = new Map<unknown, unknown>()
    for (let position = 0; position < length; position += 1) {
      dictionary.set(
        read(reference(position), depth + 1),
        read(reference(length + position), depth + 1)
      )
    }
    return dictionary
  }
  const checked = (at: number, size: number) => {
    if (at + size > trailer) throw new RangeError("Outside the file")
    return at
  }
  return Result.getOrElse(
    Result.try(() => read(top, 0)),
    () => null
  )
}
