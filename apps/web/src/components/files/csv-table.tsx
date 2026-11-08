import * as React from "react"
import type { DatabaseSort } from "@workspace/contracts"

import {
  DatabaseGrid,
  type DatabaseGridColumn,
} from "@/components/database-viewer/database-grid"
import { createDatabasePageStore } from "@/components/database-viewer/database-page-store"
import { FilePageContent } from "@/components/files/file-page-content"
import type { FileTextViewProps } from "@/components/files/file-text-view"
import { delimitedTable } from "@/lib/delimited-text"

const delimiterNames: Record<string, string> = {
  "\t": "Tab",
  ",": "Comma",
  ";": "Semicolon",
  "|": "Pipe",
}

interface ParsedTable {
  readonly columns: ReadonlyArray<DatabaseGridColumn>
  readonly delimiter: string
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
}

interface TooLarge {
  readonly kind: "too-large"
  readonly columns: number
  readonly rows: number
}

/**
 * A CSV or TSV file as a table, read from the editor's text so unsaved
 * changes show. Its first row names the columns.
 */
export function CsvTable({
  displayPath,
  path,
  sessionStore,
}: FileTextViewProps) {
  const value = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getValueSnapshot,
    sessionStore.getValueSnapshot
  )
  const source = React.useDeferredValue(value)
  const table = React.useMemo(() => parseTable(path, source), [path, source])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {"kind" in table ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div className="max-w-xs">
            <p className="text-sm font-semibold">Too large for a table</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {table.columns.toLocaleString()} columns and{" "}
              {table.rows.toLocaleString()} rows is more than the table shows.
              Switch to Source to read it.
            </p>
          </div>
        </div>
      ) : (
        <CsvGrid path={path} table={table} />
      )}
      <FilePageContent path={displayPath} view="csv" />
    </div>
  )
}

function CsvGrid({ path, table }: { path: string; table: ParsedTable }) {
  const [sort, setSort] = React.useState<DatabaseSort | null>(null)
  const rows = React.useMemo(() => sortRows(table, sort), [table, sort])
  const [page] = React.useState(createDatabasePageStore)
  React.useLayoutEffect(() => {
    page.setPage({
      columns: table.columns.map((column) => column.name),
      error: null,
      keys: null,
      offset: 0,
      rows,
      status: "success",
      total: rows.length,
      totalCapped: false,
    })
  }, [page, rows, table.columns])

  return (
    <>
      <div className="type-meta flex h-8 shrink-0 items-center gap-3 border-b bg-muted/10 px-3 font-mono text-muted-foreground">
        <span>
          {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
        </span>
        <span>
          {table.columns.length.toLocaleString()}{" "}
          {table.columns.length === 1 ? "column" : "columns"}
        </span>
        <span className="ml-auto">
          {delimiterNames[table.delimiter] ?? table.delimiter} separated
        </span>
      </div>
      <DatabaseGrid
        ariaLabel={`${path.split("/").at(-1) ?? path} rows`}
        columns={table.columns}
        editStore={null}
        emptyMessage="This file has no rows."
        page={page}
        sort={sort}
        onSortChange={setSort}
      />
    </>
  )
}

function parseTable(path: string, text: string): ParsedTable | TooLarge {
  const table = delimitedTable(path, text)
  if (table.kind === "too-large") {
    return { kind: "too-large", columns: table.columns, rows: table.rows }
  }
  const columns = table.columns.map((name, index) => ({
    name,
    // Numbers line up on the right, as in a database's numeric columns.
    type:
      table.rows.length && table.rows.every((row) => isNumberCell(row[index]))
        ? "REAL"
        : null,
    readOnly: true,
  }))
  return { columns, delimiter: table.delimiter, rows: table.rows }
}

function isNumberCell(value: string | null | undefined) {
  return !value || (value.trim() !== "" && Number.isFinite(Number(value)))
}

function sortRows(table: ParsedTable, sort: DatabaseSort | null) {
  if (!sort) return table.rows
  const index = table.columns.findIndex((column) => column.name === sort.column)
  if (index === -1) return table.rows
  const numeric = table.columns[index]?.type === "REAL"
  const direction = sort.direction === "asc" ? 1 : -1
  const collator = new Intl.Collator(undefined, { numeric: true })
  return [...table.rows].sort((left, right) => {
    const a = left[index] ?? ""
    const b = right[index] ?? ""
    if (!a || !b) return a ? -1 : b ? 1 : 0
    return (
      direction * (numeric ? Number(a) - Number(b) : collator.compare(a, b))
    )
  })
}
