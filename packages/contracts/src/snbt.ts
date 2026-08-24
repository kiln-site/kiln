import { Result } from "effect"

export const nbtTagTypes = [
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
] as const

export type NbtTagType = (typeof nbtTagTypes)[number]

type NumericTag<Type extends NbtTagType, Value extends number | bigint> = {
  type: Type
  value: Value
}

export type NbtTag =
  | NumericTag<"byte" | "short" | "int" | "float" | "double", number>
  | NumericTag<"long", bigint>
  | { type: "byteArray"; value: number[] }
  | { type: "string"; value: string }
  | {
      type: "list"
      elementType: NbtTagType | "mixed"
      value: NbtTag[]
    }
  | { type: "compound"; value: Array<{ name: string; tag: NbtTag }> }
  | { type: "intArray"; value: number[] }
  | { type: "longArray"; value: bigint[] }

export type SnbtDiagnostic = {
  column: number
  from: number
  line: number
  message: string
  to: number
}

export class SnbtParseError extends Error {
  readonly column: number
  readonly index: number
  readonly line: number

  constructor(message: string, source: string, index: number) {
    const safeIndex = Math.max(0, Math.min(index, source.length))
    const before = source.slice(0, safeIndex)
    const lines = before.split("\n")
    const line = lines.length
    const column = (lines.at(-1)?.length ?? 0) + 1
    super(`${message} at line ${line}, column ${column}`)
    this.name = "SnbtParseError"
    this.column = column
    this.index = safeIndex
    this.line = line
  }
}

export function parseSnbt(
  source: string,
  options: { binaryCompatible?: boolean } = {}
): NbtTag {
  return new SnbtParser(source, options.binaryCompatible ?? false).parse()
}

export function snbtDiagnostic(
  source: string,
  options: { binaryCompatible?: boolean } = {}
): SnbtDiagnostic | null {
  const parsed = Result.try(() => parseSnbt(source, options))
  if (Result.isSuccess(parsed)) return null
  const cause = parsed.failure
  if (!(cause instanceof SnbtParseError)) throw cause
  return {
    column: cause.column,
    from: cause.index,
    line: cause.line,
    message: cause.message,
    to: Math.min(source.length, cause.index + 1),
  }
}

export function formatSnbt(tag: NbtTag, indent = 2): string {
  return `${formatTag(tag, 0, Math.max(0, indent))}\n`
}

class SnbtParser {
  #index = 0

  constructor(
    readonly source: string,
    readonly binaryCompatible: boolean
  ) {}

  parse() {
    this.#skipWhitespace()
    if (this.#index >= this.source.length) this.#fail("Expected an SNBT value")
    const tag = this.#parseTag(0)
    this.#skipWhitespace()
    if (this.#index !== this.source.length) {
      this.#fail("Unexpected content after the root value")
    }
    return tag
  }

  #parseTag(depth: number): NbtTag {
    if (depth > 512) this.#fail("SNBT nesting exceeds 512 levels")
    this.#skipWhitespace()
    const character = this.source[this.#index]
    if (character === "{") return this.#parseCompound(depth)
    if (character === "[") return this.#parseListOrArray(depth)
    if (character === '"' || character === "'") {
      return { type: "string", value: this.#parseQuotedString() }
    }

    const start = this.#index
    const token = this.#parseBareToken()
    if (!token) this.#fail("Expected an SNBT value", start)

    this.#skipWhitespace()
    if (this.source[this.#index] === "(" && /^(?:bool|uuid)$/u.test(token)) {
      return this.#parseOperation(token, depth)
    }

    if (token === "true") return { type: "byte", value: 1 }
    if (token === "false") return { type: "byte", value: 0 }
    const numeric = parseNumericTag(token, this.source, start)
    if (numeric) return numeric
    if (/^[\d.+-]/u.test(token)) {
      this.#fail(
        "Unquoted strings cannot start with a number, '.', '+', or '-'",
        start
      )
    }
    return { type: "string", value: token }
  }

  #parseCompound(depth: number): NbtTag {
    this.#index += 1
    const value: Array<{ name: string; tag: NbtTag }> = []
    this.#skipWhitespace()
    if (this.#take("}")) return { type: "compound", value }

    while (true) {
      this.#skipWhitespace()
      const character = this.source[this.#index]
      const name =
        character === '"' || character === "'"
          ? this.#parseQuotedString()
          : this.#parseKey()
      if (!name) this.#fail("Expected a compound key")
      this.#skipWhitespace()
      this.#expect(":", "Expected ':' after the compound key")
      value.push({ name, tag: this.#parseTag(depth + 1) })
      this.#skipWhitespace()
      if (this.#take("}")) break
      this.#expect(",", "Expected ',' or '}' after the compound value")
      this.#skipWhitespace()
      if (this.source[this.#index] === "}") {
        this.#fail("Trailing commas are not valid SNBT")
      }
    }
    return { type: "compound", value }
  }

  #parseListOrArray(depth: number): NbtTag {
    this.#index += 1
    this.#skipWhitespace()
    const checkpoint = this.#index
    const prefix = this.source[this.#index]?.toUpperCase()
    if (prefix === "B" || prefix === "I" || prefix === "L") {
      this.#index += 1
      this.#skipWhitespace()
      if (this.#take(";")) return this.#parseArray(prefix)
      this.#index = checkpoint
    }

    const value: NbtTag[] = []
    if (this.#take("]")) {
      return { type: "list", elementType: "end", value }
    }

    while (true) {
      value.push(this.#parseTag(depth + 1))
      this.#skipWhitespace()
      if (this.#take("]")) break
      this.#expect(",", "Expected ',' or ']' after the list value")
      this.#skipWhitespace()
      if (this.source[this.#index] === "]") {
        this.#fail("Trailing commas are not valid SNBT")
      }
    }

    let firstType = value[0]?.type ?? "end"
    let homogeneous = value.every((tag) => tag.type === firstType)
    if (this.binaryCompatible && !homogeneous) {
      for (let index = 0; index < value.length; index += 1) {
        const tag = value[index]
        if (tag && tag.type !== "compound") {
          value[index] = {
            type: "compound",
            value: [{ name: "", tag }],
          }
        }
      }
      firstType = "compound"
      homogeneous = true
    }
    return {
      type: "list",
      elementType: homogeneous ? firstType : "mixed",
      value,
    }
  }

  #parseArray(prefix: "B" | "I" | "L"): NbtTag {
    const numbers: Array<number | bigint> = []
    this.#skipWhitespace()
    if (this.#take("]")) return arrayTag(prefix, numbers)

    while (true) {
      this.#skipWhitespace()
      const start = this.#index
      const token = this.#parseBareToken()
      if (!token) this.#fail("Expected a numeric array value", start)
      const numeric = parseNumericTag(token, this.source, start)
      if (!numeric || !isIntegerTag(numeric)) {
        this.#fail("Typed arrays can only contain integers", start)
      }
      const expected = prefix === "B" ? "byte" : prefix === "I" ? "int" : "long"
      const value = numeric.value
      numbers.push(coerceArrayInteger(value, expected, this.source, start))
      this.#skipWhitespace()
      if (this.#take("]")) break
      this.#expect(",", "Expected ',' or ']' after the array value")
      this.#skipWhitespace()
      if (this.source[this.#index] === "]") {
        this.#fail("Trailing commas are not valid SNBT")
      }
    }
    return arrayTag(prefix, numbers)
  }

  #parseOperation(operation: string, depth: number): NbtTag {
    this.#index += 1
    const argument = this.#parseTag(depth + 1)
    this.#skipWhitespace()
    this.#expect(")", `Expected ')' after ${operation} argument`)

    if (operation === "bool") {
      if (
        argument.type === "byte" ||
        argument.type === "short" ||
        argument.type === "int"
      ) {
        return { type: "byte", value: argument.value === 0 ? 0 : 1 }
      }
      if (argument.type === "long") {
        return { type: "byte", value: argument.value === 0n ? 0 : 1 }
      }
      this.#fail("bool() expects a boolean or numeric argument")
    }

    if (argument.type !== "string") this.#fail("uuid() expects a string")
    const hex = argument.value.replaceAll("-", "")
    if (!/^[\da-f]{32}$/iu.test(hex)) this.#fail("uuid() expects a valid UUID")
    return {
      type: "intArray",
      value: [0, 8, 16, 24].map((offset) =>
        Number(BigInt.asIntN(32, BigInt(`0x${hex.slice(offset, offset + 8)}`)))
      ),
    }
  }

  #parseQuotedString() {
    const quote = this.source[this.#index]
    this.#index += 1
    let value = ""
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]
      if (character === quote) return value
      if (character !== "\\") {
        value += character
        continue
      }
      const escapeIndex = this.#index - 1
      const escaped = this.source[this.#index++]
      const simpleEscapes: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        s: " ",
        t: "\t",
        "\\": "\\",
        '"': '"',
        "'": "'",
      }
      if (escaped in simpleEscapes) {
        value += simpleEscapes[escaped] ?? ""
        continue
      }
      const digits =
        escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0
      if (digits > 0) {
        const encoded = this.source.slice(this.#index, this.#index + digits)
        if (!new RegExp(`^[\\da-f]{${digits}}$`, "iu").test(encoded)) {
          this.#fail(`Expected ${digits} hexadecimal digits`, this.#index)
        }
        const codePoint = Number.parseInt(encoded, 16)
        if (codePoint > 0x10ffff)
          this.#fail("Unicode escape is out of range", escapeIndex)
        value += String.fromCodePoint(codePoint)
        this.#index += digits
        continue
      }
      if (escaped === "N" && this.source[this.#index] === "{") {
        const close = this.source.indexOf("}", this.#index + 1)
        const name = close < 0 ? "" : this.source.slice(this.#index + 1, close)
        if (!/^[-A-Za-z\d ]+$/u.test(name)) {
          this.#fail("Expected a Unicode character name", this.#index)
        }
        if (this.binaryCompatible) {
          this.#fail(
            "Named Unicode escapes are not supported in binary NBT files; use a \\u or \\U escape",
            escapeIndex
          )
        }
        value += `\\N{${name}}`
        this.#index = close + 1
        continue
      }
      this.#fail(`Unknown escape sequence \\${escaped ?? ""}`, escapeIndex)
    }
    this.#fail("Unterminated quoted string")
  }

  #parseBareToken() {
    const start = this.#index
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]
      if (!character || /[\s,\]}()]/u.test(character)) break
      this.#index += 1
    }
    return this.source.slice(start, this.#index)
  }

  #parseKey() {
    const start = this.#index
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]
      if (!character || character === ":" || /\s/u.test(character)) break
      if (character === "," || character === "}") break
      this.#index += 1
    }
    return this.source.slice(start, this.#index)
  }

  #skipWhitespace() {
    while (/\s/u.test(this.source[this.#index] ?? "")) this.#index += 1
  }

  #take(character: string) {
    if (this.source[this.#index] !== character) return false
    this.#index += 1
    return true
  }

  #expect(character: string, message: string) {
    if (!this.#take(character)) this.#fail(message)
  }

  #fail(message: string, index = this.#index): never {
    throw new SnbtParseError(message, this.source, index)
  }
}

function parseNumericTag(
  token: string,
  source: string,
  index: number
): NbtTag | null {
  const unsignedToken = token.replace(/^[+-]/u, "")
  const radix =
    unsignedToken.startsWith("0x") || unsignedToken.startsWith("0X")
      ? "hex"
      : unsignedToken.startsWith("0b") || unsignedToken.startsWith("0B")
        ? "binary"
        : "decimal"
  const suffixPattern =
    radix === "hex"
      ? /((?:[su][bBsSiIlL])|[sSiIlL])$/u
      : radix === "binary"
        ? /([su]?[bBsSiIlL])$/u
        : /([su]?[bBsSiIlLfFdD])$/u
  const suffixToken = suffixPattern.exec(token)?.[1] ?? ""
  const suffixMatch = /^([su]?)([bBsSiIlLfFdD])$/u.exec(suffixToken)
  const suffix = suffixMatch?.[2]?.toLowerCase()
  const signMode = suffixMatch?.[1]?.toLowerCase()
  const body = suffixMatch ? token.slice(0, -suffixToken.length) : token
  const digitPattern = radix === "hex" ? /[\da-f]/iu : /\d/u
  for (let offset = 0; offset < body.length; offset += 1) {
    if (body[offset] !== "_") continue
    if (
      !digitPattern.test(body[offset - 1] ?? "") ||
      !digitPattern.test(body[offset + 1] ?? "")
    ) {
      throw new SnbtParseError(
        "Numeric separators must appear between digits",
        source,
        index + offset
      )
    }
  }
  const normalized = body.replaceAll("_", "")
  const isFloat =
    suffix === "f" ||
    suffix === "d" ||
    (radix === "decimal" && /[.eE]/u.test(normalized))

  if (isFloat) {
    if (suffix && suffix !== "f" && suffix !== "d") {
      throw new SnbtParseError(
        "Integer suffix cannot be used on a decimal",
        source,
        index
      )
    }
    if (
      !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/u.test(normalized)
    ) {
      return null
    }
    const value = Number(normalized)
    if (!Number.isFinite(value)) {
      throw new SnbtParseError("SNBT numbers must be finite", source, index)
    }
    return { type: suffix === "f" ? "float" : "double", value }
  }

  if (!/^[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+)$/u.test(normalized))
    return null
  if (radix === "decimal" && /^[+-]?0\d+/u.test(normalized)) {
    throw new SnbtParseError(
      "Non-zero decimal integers cannot start with zero",
      source,
      index
    )
  }
  const negative = normalized.startsWith("-")
  const unsignedBody = /^[+-]/u.test(normalized)
    ? normalized.slice(1)
    : normalized
  let value = BigInt(unsignedBody)
  if (negative) value = -value

  const type =
    suffix === "b"
      ? "byte"
      : suffix === "s"
        ? "short"
        : suffix === "l"
          ? "long"
          : "int"
  const bits =
    type === "byte" ? 8 : type === "short" ? 16 : type === "long" ? 64 : 32
  if (signMode === "u") {
    const max = (1n << BigInt(bits)) - 1n
    if (value < 0n || value > max) {
      throw new SnbtParseError(
        `Unsigned ${type} is out of range`,
        source,
        index
      )
    }
    value = BigInt.asIntN(bits, value)
  } else {
    const min = -(1n << BigInt(bits - 1))
    const max = (1n << BigInt(bits - 1)) - 1n
    if (value < min || value > max) {
      throw new SnbtParseError(
        `${capitalize(type)} is out of range`,
        source,
        index
      )
    }
  }
  return type === "long" ? { type, value } : { type, value: Number(value) }
}

function isIntegerTag(
  tag: NbtTag
): tag is Extract<NbtTag, { type: "byte" | "short" | "int" | "long" }> {
  return (
    tag.type === "byte" ||
    tag.type === "short" ||
    tag.type === "int" ||
    tag.type === "long"
  )
}

function coerceArrayInteger(
  value: number | bigint,
  type: "byte" | "int" | "long",
  source: string,
  index: number
) {
  const integer = typeof value === "bigint" ? value : BigInt(value)
  const bits = type === "byte" ? 8 : type === "int" ? 32 : 64
  const min = -(1n << BigInt(bits - 1))
  const max = (1n << BigInt(bits - 1)) - 1n
  if (integer < min || integer > max) {
    throw new SnbtParseError(
      `${capitalize(type)} array value is out of range`,
      source,
      index
    )
  }
  return type === "long" ? integer : Number(integer)
}

function arrayTag(
  prefix: "B" | "I" | "L",
  numbers: Array<number | bigint>
): NbtTag {
  if (prefix === "B") return { type: "byteArray", value: numbers.map(Number) }
  if (prefix === "I") return { type: "intArray", value: numbers.map(Number) }
  return { type: "longArray", value: numbers.map(BigInt) }
}

function formatTag(tag: NbtTag, depth: number, indent: number): string {
  switch (tag.type) {
    case "byte":
      return `${tag.value}b`
    case "short":
      return `${tag.value}s`
    case "int":
      return String(tag.value)
    case "long":
      return `${tag.value}L`
    case "float":
      return `${formatDecimal(tag.value)}f`
    case "double":
      return `${formatDecimal(tag.value)}d`
    case "string":
      return quoteString(tag.value)
    case "byteArray":
      return `[B; ${tag.value.map((value) => `${value}b`).join(", ")}]`
    case "intArray":
      return `[I; ${tag.value.join(", ")}]`
    case "longArray":
      return `[L; ${tag.value.map((value) => `${value}L`).join(", ")}]`
    case "list":
      return formatCollection(
        "[",
        "]",
        tag.value.map((value) => formatTag(value, depth + 1, indent)),
        depth,
        indent
      )
    case "compound":
      return formatCollection(
        "{",
        "}",
        tag.value.map(
          ({ name, tag: value }) =>
            `${formatKey(name)}: ${formatTag(value, depth + 1, indent)}`
        ),
        depth,
        indent
      )
  }
}

function formatCollection(
  open: string,
  close: string,
  values: string[],
  depth: number,
  indent: number
) {
  if (values.length === 0) return `${open}${close}`
  if (indent === 0) return `${open}${values.join(", ")}${close}`
  const padding = " ".repeat((depth + 1) * indent)
  const closingPadding = " ".repeat(depth * indent)
  return `${open}\n${padding}${values.join(`,\n${padding}`)}\n${closingPadding}${close}`
}

function formatDecimal(value: number) {
  if (!Number.isFinite(value))
    throw new Error("Cannot format a non-finite NBT number")
  const encoded = String(value)
  return /[.eE]/u.test(encoded) ? encoded : `${encoded}.0`
}

function formatKey(value: string) {
  return /^[A-Za-z0-9._+-]+$/u.test(value) && value.length > 0
    ? value
    : quoteString(value)
}

function quoteString(value: string) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`
}

function capitalize(value: string) {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`
}
