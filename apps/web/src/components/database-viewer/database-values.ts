import type { DatabaseRowKey, DatabaseValue } from "@workspace/contracts"

export function isBlobValue(
  value: DatabaseValue
): value is Extract<DatabaseValue, { $blob: string }> {
  return typeof value === "object" && value !== null && "$blob" in value
}

export function isBigIntValue(
  value: DatabaseValue
): value is Extract<DatabaseValue, { $bigint: string }> {
  return typeof value === "object" && value !== null && "$bigint" in value
}

export function formatByteSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// Single-line text for grid cells; long values are truncated by CSS.
export function formatCellValue(value: DatabaseValue): string {
  if (value === null) return "NULL"
  if (typeof value === "string") return value.replace(/\s+/gu, " ")
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (isBigIntValue(value)) return value.$bigint
  return `BLOB ${formatByteSize(value.size)}`
}

export function editableText(value: DatabaseValue): string {
  if (value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (isBigIntValue(value)) return value.$bigint
  return blobHex(value)
}

export function blobHex(value: Extract<DatabaseValue, { $blob: string }>) {
  const bytes = atob(value.$blob)
  let hex = ""
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes.charCodeAt(index).toString(16).padStart(2, "0")
  }
  return value.truncated ? `${hex}…` : hex
}

export function isValueEditable(value: DatabaseValue) {
  return !isBlobValue(value)
}

// Text from an input keeps the original value type when it round-trips, so
// untouched numbers stay numbers. SQLite type affinity converts the rest.
export function parseEditedText(
  text: string,
  previous: DatabaseValue,
  column: { type: string | null } | undefined
): DatabaseValue {
  if (editableText(previous) === text) return previous
  const affinity = columnAffinity(column?.type ?? "")
  const trimmed = text.trim()
  // INTEGER and NUMERIC affinity both store whole numbers as exact 64-bit
  // integers, so they must not round-trip through a double. Anything wider
  // goes as text for SQLite to convert under its affinity rules.
  if (
    (affinity === "integer" || affinity === "numeric") &&
    /^-?\d+$/u.test(trimmed)
  ) {
    const parsed = Number(trimmed)
    if (Number.isSafeInteger(parsed)) return parsed
    const exact = BigInt(trimmed)
    return exact >= INT64_MIN && exact <= INT64_MAX
      ? { $bigint: exact.toString() }
      : trimmed
  }
  // Fractions are only binary floats in float columns. DECIMAL and NUMERIC
  // columns keep every digit, so their input goes as text for the database
  // to parse exactly (SQLite's NUMERIC affinity converts it the same way).
  if (
    (affinity === "real" || affinity === "integer") &&
    trimmed !== "" &&
    Number.isFinite(Number(trimmed))
  ) {
    return Number(trimmed)
  }
  return affinity === "numeric" && trimmed !== "" ? trimmed : text
}

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

function columnAffinity(type: string) {
  const upper = type.toUpperCase()
  if (upper.includes("INT")) return "integer"
  if (/CHAR|CLOB|TEXT/u.test(upper)) return "text"
  if (upper === "" || upper.includes("BLOB")) return "blob"
  if (/REAL|FLOA|DOUB/u.test(upper)) return "real"
  return "numeric"
}

export function valuesEqual(left: DatabaseValue, right: DatabaseValue) {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== "object" || typeof right !== "object") return false
  if (isBigIntValue(left) && isBigIntValue(right)) {
    return left.$bigint === right.$bigint
  }
  if (isBlobValue(left) && isBlobValue(right)) {
    return left.$blob === right.$blob && left.size === right.size
  }
  return false
}

export function rowKeyId(key: DatabaseRowKey) {
  return JSON.stringify(
    Object.entries(key).sort(([a], [b]) => a.localeCompare(b))
  )
}

export function isNumericType(type: string | null | undefined) {
  if (!type) return false
  const affinity = columnAffinity(type)
  return affinity === "integer" || affinity === "real"
}
