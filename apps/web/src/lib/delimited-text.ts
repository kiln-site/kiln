// Comma- and tab-separated text, as RFC 4180 describes it: quoted fields
// may hold delimiters, line breaks, and quotes written twice.

const candidateDelimiters = [",", "\t", ";", "|"] as const

/**
 * The delimiter a file uses: a tab for `.tsv`, otherwise whichever of comma,
 * tab, semicolon, or pipe its first line uses most outside quotes.
 */
export function delimiterFor(path: string, text: string): string {
  if (/\.(?:tsv|tab)$/iu.test(path)) return "\t"
  const counts = new Map<string, number>()
  let quoted = false
  for (let index = 0; index < text.length && index < 64 * 1024; index += 1) {
    const character = text[index]
    if (character === '"') quoted = !quoted
    else if (!quoted && (character === "\n" || character === "\r")) break
    else if (!quoted && character !== undefined) {
      counts.set(character, (counts.get(character) ?? 0) + 1)
    }
  }
  let best = ","
  for (const delimiter of candidateDelimiters) {
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0)) {
      best = delimiter
    }
  }
  return best
}

/** The rows of delimited text, each a list of its fields. */
function parseDelimitedText(
  text: string,
  delimiter: string
): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  // A byte order mark isn't part of the first field.
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const end = text.length
  while (index <= end) {
    if (index === end) {
      // Only a delimiter leaves a row open here: its last field is empty.
      if (row.length) rows.push([...row, ""])
      break
    }
    let field: string
    if (text[index] === '"') {
      let close = index + 1
      let value = ""
      for (;;) {
        const quote = text.indexOf('"', close)
        if (quote === -1) {
          // An unclosed quote runs to the end of the text.
          value += text.slice(close)
          close = end
          break
        }
        value += text.slice(close, quote)
        if (text[quote + 1] === '"') {
          value += '"'
          close = quote + 2
          continue
        }
        close = quote + 1
        break
      }
      // Anything between the closing quote and the delimiter is kept.
      let next = close
      while (
        next < end &&
        text[next] !== delimiter &&
        text[next] !== "\n" &&
        text[next] !== "\r"
      ) {
        next += 1
      }
      field = value + text.slice(close, next)
      index = next
    } else {
      let next = index
      while (
        next < end &&
        text[next] !== delimiter &&
        text[next] !== "\n" &&
        text[next] !== "\r"
      ) {
        next += 1
      }
      field = text.slice(index, next)
      index = next
    }
    row.push(field)
    if (index >= end) {
      rows.push(row)
      break
    }
    const separator = text[index]
    index += 1
    if (separator === delimiter) continue
    if (separator === "\r" && text[index] === "\n") index += 1
    rows.push(row)
    row = []
  }
  return rows
}

// A table bigger than this is left to the source view: padding every row to
// the widest one would otherwise turn a small file into millions of cells.
export const MAX_TABLE_COLUMNS = 1_000
export const MAX_TABLE_CELLS = 2_000_000

export type DelimitedTable =
  | {
      readonly kind: "table"
      readonly delimiter: string
      /** The column names, from the first row; blank and repeated ones numbered. */
      readonly columns: ReadonlyArray<string>
      /** Every row after the first, as wide as the widest row. */
      readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
    }
  | {
      readonly kind: "too-large"
      readonly delimiter: string
      readonly columns: number
      readonly rows: number
    }

/** A delimited file as a table whose first row names its columns. */
export function delimitedTable(path: string, text: string): DelimitedTable {
  const delimiter = delimiterFor(path, text)
  const [header = [], ...body] = parseDelimitedText(text, delimiter)
  let width = header.length
  for (const row of body) if (row.length > width) width = row.length
  if (width > MAX_TABLE_COLUMNS || width * body.length > MAX_TABLE_CELLS) {
    return { kind: "too-large", delimiter, columns: width, rows: body.length }
  }
  // Columns are told apart by name, so every name is unique, including the
  // ones given to blank and repeated headers.
  const used = new Set<string>()
  const nextSuffix = new Map<string, number>()
  const columns = Array.from({ length: width }, (_, index) => {
    const base = header[index]?.trim() || `Column ${index + 1}`
    let name = base
    let suffix = nextSuffix.get(base) ?? 2
    while (used.has(name)) {
      name = `${base} (${suffix})`
      suffix += 1
    }
    nextSuffix.set(base, suffix)
    used.add(name)
    return name
  })
  const rows = body.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? null)
  )
  return { kind: "table", delimiter, columns, rows }
}
