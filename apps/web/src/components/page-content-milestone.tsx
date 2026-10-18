import { usePageContent } from "@/lib/page-timing"

/**
 * Marks the open page's content once `reached`, as `view`. Rendered beside
 * the content rather than inside it, so a new open re-renders only this.
 */
export function PageContentMilestone({
  reached = true,
  view,
}: {
  reached?: boolean
  view: string
}) {
  usePageContent(reached, view)
  return null
}
