/**
 * The protobuf wire format, for the few BuildKit messages the Relay reads
 * and writes (build progress, and a build session's file sync).
 */

/** A message's fields: varints as numbers, length-delimited as buffers. */
export function* protobufFields(
  buffer: Buffer
): Generator<readonly [number, number | Buffer]> {
  let offset = 0
  const varint = () => {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = buffer[offset]
      if (byte === undefined) throw new Error("Truncated protobuf varint")
      offset += 1
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return value
      scale *= 128
    }
  }
  while (offset < buffer.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) yield [field, varint()]
    else if (wire === 2) {
      const length = varint()
      const value = buffer.subarray(offset, offset + length)
      if (value.length !== length) throw new Error("Truncated protobuf field")
      offset += length
      yield [field, value]
    } else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else throw new Error(`Unsupported protobuf wire type ${wire}`)
  }
}

/**
 * Writes a message: each field in order, leaving out zero values as proto3
 * does. Integers are varints (int64 as two's complement); strings, bytes,
 * and nested messages are length-delimited.
 */
export function protobufMessage(
  fields: ReadonlyArray<
    readonly [number, bigint | Buffer | number | string | undefined]
  >
): Buffer {
  const parts: Array<Buffer> = []
  for (const [field, value] of fields) {
    if (value === undefined) continue
    if (typeof value === "number" || typeof value === "bigint") {
      if (BigInt(value) === 0n) continue
      parts.push(varint(BigInt(field) << 3n), varint(BigInt(value)))
      continue
    }
    const bytes = typeof value === "string" ? Buffer.from(value) : value
    if (bytes.length === 0) continue
    parts.push(
      varint((BigInt(field) << 3n) | 2n),
      varint(BigInt(bytes.length)),
      bytes
    )
  }
  return Buffer.concat(parts)
}

function varint(value: bigint): Buffer {
  let remaining = BigInt.asUintN(64, value)
  const bytes: Array<number> = []
  do {
    const byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    bytes.push(remaining === 0n ? byte : byte | 0x80)
  } while (remaining !== 0n)
  return Buffer.from(bytes)
}
