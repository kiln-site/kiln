import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  createTableHook,
  filterFn_includesString,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table"

export interface DataTableColumnMeta {
  cellClassName?: string
  headerClassName?: string
}

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { text: sortFn_text },
  columnMeta: {} as DataTableColumnMeta,
})

export const {
  createAppColumnHelper: createDataTableColumnHelper,
  useAppTable: useDataTable,
} = createTableHook({ features: dataTableFeatures })
