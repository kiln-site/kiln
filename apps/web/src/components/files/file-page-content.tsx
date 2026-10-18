import * as React from "react"
import { Result } from "effect"

import { usePageContent } from "@/lib/page-timing"

/**
 * Marks a Files page's content once `reached`, as `view`, for an open of the
 * Files URL that shows `path`. Rendered beside the content rather than inside
 * it, so a new open re-renders only this.
 */
export function FilePageContent({
  path,
  reached = true,
  view,
}: {
  path: string
  reached?: boolean
  view: string
}) {
  const shows = React.useCallback(
    (urlPath: string) => filesUrlPath(urlPath) === trimSlashes(path),
    [path]
  )
  usePageContent(reached, view, shows)
  return null
}

// The path a Files URL shows, with or without its directory's trailing
// slash: `/server/abc/files/plugins/` shows `plugins`.
function filesUrlPath(urlPath: string): string | null {
  const match = /^\/(?:server|app|relay)\/[^/]+\/files(?:\/(.*))?$/u.exec(
    urlPath
  )
  if (!match) return null
  const encoded = match[1] ?? ""
  return trimSlashes(
    Result.getOrElse(
      Result.try(() => decodeURIComponent(encoded)),
      () => encoded
    )
  )
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/gu, "")
}
