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
  if (affinity === "integer" && /^-?\d+$/u.test(text.trim())) {
    const parsed = Number(text.trim())
    return Number.isSafeInteger(parsed) ? parsed : { $bigint: text.trim() }
  }
  if (
    (affinity === "real" || affinity === "numeric" || affinity === "integer") &&
    text.trim() !== "" &&
    Number.isFinite(Number(text))
  ) {
    return Number(text)
  }
  return text
}

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
