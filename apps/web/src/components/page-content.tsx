import { usePageContent } from "@/lib/page-timing"

/**
 * Marks the open page's content once `reached`, as `view`, for a view that
 * stands in for whichever page was opened, such as a workspace still
 * provisioning. Rendered beside it, so a new open re-renders only this.
 */
export function PageContent({
  reached = true,
  view,
}: {
  reached?: boolean
  view: string
}) {
  usePageContent(reached, view, showsAnyPath)
  return null
}

function showsAnyPath() {
  return true
}
