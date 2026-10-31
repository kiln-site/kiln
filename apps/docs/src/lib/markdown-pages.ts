import markdownPages from "virtual:docs/markdown"

import { withBase } from "~/lib/base"
import { orderedPages } from "~/lib/pages"

// Server-only: every page's Markdown, in sidebar order, for llms.txt and
// "Copy page". The routes that import it run only on the server.

const byPath = new Map(markdownPages.map((page) => [page.path, page]))

export function markdownFor(path: string): string | undefined {
  const page = byPath.get(path)
  if (!page) return undefined
  return `# ${page.title}\n\n> ${page.description}\n\n${page.markdown}\n`
}

// Pages in sidebar order, then any the sidebar leaves out.
export function pagesInOrder() {
  const listed = orderedPages.flatMap((entry) => byPath.get(entry.path) ?? [])
  const listedPaths = new Set(listed.map((page) => page.path))
  return [
    ...listed,
    ...markdownPages.filter((page) => !listedPaths.has(page.path)),
  ]
}

export function pageUrl(siteUrl: string, path: string): string {
  return `${siteUrl}${withBase(path)}`
}

export const textHeaders = {
  "Cache-Control": "public, max-age=300",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const
