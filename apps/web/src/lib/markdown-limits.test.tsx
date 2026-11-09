import ReactMarkdown from "react-markdown"
import { renderToStaticMarkup } from "react-dom/server"
import remarkGfm from "remark-gfm"
import { expect, it } from "vite-plus/test"

import {
  MAX_MARKDOWN_TABLE_COLUMNS,
  remarkLimitTables,
} from "@/lib/markdown-limits"

function render(markdown: string) {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkLimitTables]}>
      {markdown}
    </ReactMarkdown>
  )
}

function table(columns: number, rows: number) {
  const header = `|${" h |".repeat(columns)}`
  const divider = `|${" - |".repeat(columns)}`
  // Short rows, which the table pads out to the header's width.
  return [header, divider, ...Array.from({ length: rows }, () => "| x |")].join(
    "\n"
  )
}

it("leaves a table too wide to pad to the source, rendering none of it", () => {
  const html = render(table(MAX_MARKDOWN_TABLE_COLUMNS * 10, 100))

  expect(html).not.toContain("<td")
  expect(html).toContain("too large to show here")
})

it("stops rendering tables once a document has asked for too many cells", () => {
  const html = render(
    Array.from({ length: 30 }, () => table(50, 50)).join("\n\n")
  )

  expect(html.match(/<table/gu)?.length).toBeLessThan(30)
  expect(html).toContain("too large to show here")
})
