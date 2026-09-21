import {
  createSortedRowModel,
  createTableHook,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_text,
  tableFeatures,
  type ColumnDef,
  type Row,
  type RowData,
  type RowSelectionState,
  type Table,
  type TableOptions,
} from "@tanstack/react-table"

export type DataTableBreakpoint = "base" | "sm" | "md" | "lg" | "xl"

export interface DataTableColumnLayout {
  hideBelow?: Exclude<DataTableBreakpoint, "base">
  width?: string | Partial<Record<DataTableBreakpoint, string>>
}

export interface DataTableColumnMeta {
  cellClassName?: string
  headerClassName?: string
  headerLabelClassName?: string
  layout?: DataTableColumnLayout
}

export interface DataTableVirtualizationOptions {
  estimateRowHeight?: number
  overscan?: number
}

export const defaultDataTableVirtualization = {
  estimateRowHeight: 56,
  overscan: 8,
} satisfies Required<DataTableVirtualizationOptions>

export type DataTableSearchValue = boolean | number | string | null | undefined

export interface DataTableSearchDefinition<TData extends RowData> {
  fields: ReadonlyArray<(row: TData) => DataTableSearchValue>
}

export const dataTableFeatures = tableFeatures({
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { text: sortFn_text },
  columnMeta: {} as DataTableColumnMeta,
})

const { createAppColumnHelper, useAppTable: useInternalDataTable } =
  createTableHook({ features: dataTableFeatures })

export { createAppColumnHelper as createDataTableColumnHelper }

type BoundDataTableOptions<TData extends RowData> = Omit<
  TableOptions<typeof dataTableFeatures, TData>,
  "features"
>

export type DataTableModelOptions<TData extends RowData> = Omit<
  BoundDataTableOptions<TData>,
  "columns" | "data" | "getRowId"
>

export interface DataTableDefinition<TData extends RowData> {
  ariaLabel: string
  columns: Array<ColumnDef<typeof dataTableFeatures, TData, any>>
  getRowId: NonNullable<BoundDataTableOptions<TData>["getRowId"]>
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  model?: DataTableModelOptions<TData>
  search?: DataTableSearchDefinition<TData>
  virtualization?: true | DataTableVirtualizationOptions
}

export type DataTableInstance<TData extends RowData> = Table<
  typeof dataTableFeatures,
  TData
>

export function defineDataTable<TData extends RowData>(
  definition: DataTableDefinition<TData>
): DataTableDefinition<TData> {
  return definition
}

export function useDataTable<TData extends RowData>(
  options: BoundDataTableOptions<TData>
) {
  return useInternalDataTable(
    {
      enableRowSelection: false,
      ...options,
    },
    selectNoDataTableState
  )
}

export type DataTableSelectAllState =
  | "checked"
  | "disabled"
  | "indeterminate"
  | "unchecked"

/**
 * Minimal row shape the select-all checkbox needs. Rows are matched against
 * `rowSelection` by id so the state always reflects the rendered rows.
 */
export interface DataTableSelectableRow {
  id: string
  getCanSelect: () => boolean
}

export function dataTableSelectAllState(
  rows: ReadonlyArray<DataTableSelectableRow>,
  selection: RowSelectionState
): DataTableSelectAllState {
  let selectableCount = 0
  let selectedCount = 0
  for (const row of rows) {
    if (!row.getCanSelect()) continue
    selectableCount += 1
    if (selection[row.id]) selectedCount += 1
  }
  if (selectableCount === 0) return "disabled"
  if (selectedCount === 0) return "unchecked"
  return selectedCount === selectableCount ? "checked" : "indeterminate"
}

export function dataTableColumnMeta(
  layout: DataTableColumnLayout,
  meta: Omit<DataTableColumnMeta, "layout"> = {}
): DataTableColumnMeta {
  return { ...meta, layout }
}

function selectNoDataTableState() {
  return undefined
}
