import { describe, expect, it } from "vite-plus/test"
import type { RowSelectionState } from "@tanstack/react-table"

import {
  dataTableSelectAllState,
  type DataTableSelectableRow,
} from "@/lib/data-table"

function selectableRow(id: string, canSelect = true): DataTableSelectableRow {
  return { id, getCanSelect: () => canSelect }
}

describe("data table select all state", () => {
  it("disables the header checkbox until selectable rows render", () => {
    expect(dataTableSelectAllState([], {})).toBe("disabled")
    expect(
      dataTableSelectAllState([selectableRow("a", false)], { a: true })
    ).toBe("disabled")
  })

  it("checks the header checkbox once every rendered row is selected", () => {
    expect(
      dataTableSelectAllState([selectableRow("a"), selectableRow("b")], {
        a: true,
        b: true,
      })
    ).toBe("checked")
  })

  it("drops back to indeterminate when more rows load into a full selection", () => {
    const rows = [selectableRow("a"), selectableRow("b")]
    const selection: RowSelectionState = { a: true, b: true }

    expect(dataTableSelectAllState(rows, selection)).toBe("checked")
    expect(
      dataTableSelectAllState([...rows, selectableRow("c")], selection)
    ).toBe("indeterminate")
  })
})
