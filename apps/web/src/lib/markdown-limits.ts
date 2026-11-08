// Markdown that renders to far more than it says: a GFM table pads every row
// to its header's width, so a few kilobytes can ask for millions of cells.
// Tables past these limits are left to the source view.

export const MAX_MARKDOWN_TABLE_COLUMNS = 100
export const MAX_MARKDOWN_TABLE_CELLS = 50_000

interface MarkdownNode {
  type: string
  align?: ReadonlyArray<unknown> | null
  children?: Array<MarkdownNode>
  value?: string
}

/**
 * A remark plugin that replaces each table too wide, or past the document's
 * cell budget, with a note to read it in the source.
 */
export function remarkLimitTables() {
  return (tree: MarkdownNode) => {
    let cells = 0
    const visit = (node: MarkdownNode) => {
      const children = node.children
      if (!children) return
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        if (!child) continue
        if (child.type !== "table") {
          visit(child)
          continue
        }
        const rows = child.children ?? []
        let width = child.align?.length ?? 0
        for (const row of rows) {
          width = Math.max(width, row.children?.length ?? 0)
        }
        cells += width * rows.length
        if (
          width > MAX_MARKDOWN_TABLE_COLUMNS ||
          cells > MAX_MARKDOWN_TABLE_CELLS
        ) {
          children[index] = {
            type: "paragraph",
            children: [
              {
                type: "emphasis",
                children: [
                  {
                    type: "text",
                    value: `A table of ${width.toLocaleString()} columns and ${rows.length.toLocaleString()} rows is too large to show here. Switch to Source to read it.`,
                  },
                ],
              },
            ],
          }
        }
      }
    }
    visit(tree)
  }
}
