import type { NbtTag, NbtTagType } from "@workspace/contracts"
import { Result } from "effect"

export type NamedNbt = {
  name: string
  tag: NbtTag
}

const tagTypeById: readonly NbtTagType[] = [
  "end",
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "byteArray",
  "string",
  "list",
  "compound",
  "intArray",
  "longArray",
]

const tagIdByType = new Map(tagTypeById.map((type, id) => [type, id]))
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const maxNbtDepth = 512

export function decodeNbt(source: Uint8Array): NamedNbt {
  const reader = new NbtReader(source)
  const type = reader.readType(false)
  const name = reader.readString()
  const tag = reader.readPayload(type, 0)
  if (!reader.done) throw new Error("NBT file has trailing binary data")
  return { name, tag }
}

export function encodeNbt(root: NamedNbt): Buffer {
  const writer = new NbtWriter()
  writer.writeType(root.tag.type)
  writer.writeString(root.name)
  writer.writePayload(root.tag, 0)
  return writer.finish()
}

class NbtReader {
  #offset = 0
  readonly #view: DataView

  constructor(readonly source: Uint8Array) {
    this.#view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength
    )
  }

  get done() {
    return this.#offset === this.source.byteLength
  }

  readType(allowEnd: boolean) {
    const id = this.readUnsignedByte()
    const type = tagTypeById[id]
    if (!type || (!allowEnd && type === "end")) {
      throw new Error(`Invalid NBT tag type ${id}`)
    }
    return type
  }

  readString() {
    const length = this.readUnsignedShort()
    const bytes = this.readBytes(length)
    const decoded = Result.try(() => textDecoder.decode(bytes))
    if (Result.isFailure(decoded)) {
      throw new Error("NBT contains an invalid UTF-8 string")
    }
    return decoded.success
  }

  readPayload(type: NbtTagType, depth: number): NbtTag {
    if (depth > maxNbtDepth) throw new Error("NBT nesting exceeds 512 levels")
    switch (type) {
      case "end":
        throw new Error("TAG_End cannot be used as a value")
      case "byte":
        return { type, value: this.readSignedByte() }
      case "short":
        return { type, value: this.readSignedShort() }
      case "int":
        return { type, value: this.readSignedInt() }
      case "long":
        return { type, value: this.readSignedLong() }
      case "float":
        return { type, value: this.readFloat() }
      case "double":
        return { type, value: this.readDouble() }
      case "byteArray": {
        const length = this.readLength("byte array")
        return {
          type,
          value: Array.from(this.readBytes(length), (value) =>
            value > 127 ? value - 256 : value
          ),
        }
      }
      case "string":
        return { type, value: this.readString() }
      case "list": {
        const elementType = this.readType(true)
        const length = this.readLength("list")
        if (length > 0 && elementType === "end") {
          throw new Error("A non-empty NBT list cannot contain TAG_End")
        }
        return {
          type,
          elementType,
          value: Array.from({ length }, () =>
            this.readPayload(elementType, depth + 1)
          ),
        }
      }
      case "compound": {
        const value: Array<{ name: string; tag: NbtTag }> = []
        while (true) {
          const childType = this.readType(true)
          if (childType === "end") break
          const name = this.readString()
          value.push({ name, tag: this.readPayload(childType, depth + 1) })
        }
        return { type, value }
      }
      case "intArray": {
        const length = this.readLength("int array")
        return {
          type,
          value: Array.from({ length }, () => this.readSignedInt()),
        }
      }
      case "longArray": {
        const length = this.readLength("long array")
        return {
          type,
          value: Array.from({ length }, () => this.readSignedLong()),
        }
      }
    }
  }

  readLength(label: string) {
    const length = this.readSignedInt()
    if (length < 0) throw new Error(`NBT ${label} has a negative length`)
    if (length > this.source.byteLength) {
      throw new Error(`NBT ${label} length exceeds the file size`)
    }
    return length
  }

  readUnsignedByte() {
    this.#ensure(1)
    const value = this.#view.getUint8(this.#offset)
    this.#offset += 1
    return value
  }

  readSignedByte() {
    this.#ensure(1)
    const value = this.#view.getInt8(this.#offset)
    this.#offset += 1
    return value
  }

  readUnsignedShort() {
    this.#ensure(2)
    const value = this.#view.getUint16(this.#offset)
    this.#offset += 2
    return value
  }

  readSignedShort() {
    this.#ensure(2)
    const value = this.#view.getInt16(this.#offset)
    this.#offset += 2
    return value
  }

  readSignedInt() {
    this.#ensure(4)
    const value = this.#view.getInt32(this.#offset)
    this.#offset += 4
    return value
  }

  readSignedLong() {
    this.#ensure(8)
    const value = this.#view.getBigInt64(this.#offset)
    this.#offset += 8
    return value
  }

  readFloat() {
    this.#ensure(4)
    const value = this.#view.getFloat32(this.#offset)
    this.#offset += 4
    if (!Number.isFinite(value))
      throw new Error("NBT contains a non-finite float")
    return value
  }

  readDouble() {
    this.#ensure(8)
    const value = this.#view.getFloat64(this.#offset)
    this.#offset += 8
    if (!Number.isFinite(value))
      throw new Error("NBT contains a non-finite double")
    return value
  }

  readBytes(length: number) {
    this.#ensure(length)
    const value = this.source.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  #ensure(length: number) {
    if (length < 0 || this.#offset + length > this.source.byteLength) {
      throw new Error("NBT file ended before the current tag was complete")
    }
  }
}

class NbtWriter {
  readonly #chunks: Buffer[] = []

  finish() {
    return Buffer.concat(this.#chunks)
  }

  writeType(type: NbtTagType) {
    const id = tagIdByType.get(type)
    if (id === undefined) throw new Error(`Cannot encode NBT tag type ${type}`)
    this.writeUnsignedByte(id)
  }

  writeString(value: string) {
    const encoded = Buffer.from(value, "utf8")
    if (encoded.byteLength > 65_535) {
      throw new Error("NBT strings cannot exceed 65,535 UTF-8 bytes")
    }
    this.writeUnsignedShort(encoded.byteLength)
    this.#chunks.push(encoded)
  }

  writePayload(tag: NbtTag, depth: number) {
    if (depth > maxNbtDepth) throw new Error("NBT nesting exceeds 512 levels")
    switch (tag.type) {
      case "byte":
        this.writeSignedByte(tag.value)
        return
      case "short":
        this.writeSignedShort(tag.value)
        return
      case "int":
        this.writeSignedInt(tag.value)
        return
      case "long":
        this.writeSignedLong(tag.value)
        return
      case "float":
        this.writeFloat(tag.value)
        return
      case "double":
        this.writeDouble(tag.value)
        return
      case "byteArray":
        this.writeLength(tag.value.length)
        this.#chunks.push(Buffer.from(tag.value.map((value) => value & 0xff)))
        return
      case "string":
        this.writeString(tag.value)
        return
      case "list": {
        const elementType = tag.value[0]?.type ?? "end"
        if (
          tag.elementType === "mixed" ||
          tag.value.some((value) => value.type !== elementType)
        ) {
          throw new Error("Binary NBT lists must contain one tag type")
        }
        this.writeType(elementType)
        this.writeLength(tag.value.length)
        for (const child of tag.value) this.writePayload(child, depth + 1)
        return
      }
      case "compound":
        for (const { name, tag: child } of tag.value) {
          this.writeType(child.type)
          this.writeString(name)
          this.writePayload(child, depth + 1)
        }
        this.writeType("end")
        return
      case "intArray":
        this.writeLength(tag.value.length)
        for (const value of tag.value) this.writeSignedInt(value)
        return
      case "longArray":
        this.writeLength(tag.value.length)
        for (const value of tag.value) this.writeSignedLong(value)
    }
  }

  writeLength(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      throw new Error("NBT collection length is out of range")
    }
    this.writeSignedInt(value)
  }

  writeUnsignedByte(value: number) {
    const buffer = Buffer.allocUnsafe(1)
    buffer.writeUInt8(value)
    this.#chunks.push(buffer)
  }

  writeSignedByte(value: number) {
    const buffer = Buffer.allocUnsafe(1)
    buffer.writeInt8(value)
    this.#chunks.push(buffer)
  }

  writeUnsignedShort(value: number) {
    const buffer = Buffer.allocUnsafe(2)
    buffer.writeUInt16BE(value)
    this.#chunks.push(buffer)
  }

  writeSignedShort(value: number) {
    const buffer = Buffer.allocUnsafe(2)
    buffer.writeInt16BE(value)
    this.#chunks.push(buffer)
  }

  writeSignedInt(value: number) {
    const buffer = Buffer.allocUnsafe(4)
    buffer.writeInt32BE(value)
    this.#chunks.push(buffer)
  }

  writeSignedLong(value: bigint) {
    const buffer = Buffer.allocUnsafe(8)
    buffer.writeBigInt64BE(value)
    this.#chunks.push(buffer)
  }

  writeFloat(value: number) {
    if (!Number.isFinite(value)) throw new Error("NBT floats must be finite")
    const buffer = Buffer.allocUnsafe(4)
    buffer.writeFloatBE(value)
    this.#chunks.push(buffer)
  }

  writeDouble(value: number) {
    if (!Number.isFinite(value)) throw new Error("NBT doubles must be finite")
    const buffer = Buffer.allocUnsafe(8)
    buffer.writeDoubleBE(value)
    this.#chunks.push(buffer)
  }
}
