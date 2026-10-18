import * as React from "react"
import { Result } from "effect"

import { usePageContent } from "@/lib/page-timing"

/**
 * Marks a Files page's content once `reached`, as `view`, for an open of the
 * Files URL that shows `path`, or of any Files URL when the view stands in
 * for the whole workspace, such as a Relay's host files being off. Rendered
 * beside the content rather than inside it, so a new open re-renders only
 * this.
 */
export function FilePageContent({
  path,
  reached = true,
  view,
}: {
  path?: string
  reached?: boolean
  view: string
}) {
  const shows = React.useCallback(
    (urlPath: string) => showsFilesPath(urlPath, path),
    [path]
  )
  usePageContent(reached, view, shows)
  return null
}

// Whether `urlPath` is a Files URL showing `path`, with or without its
// directory's trailing slash: `/server/abc/files/plugins/` shows `plugins`.
// Client navigations give the router's decoded path and a fresh tab gives
// the browser's encoded one, so either form matches.
function showsFilesPath(urlPath: string, path: string | undefined): boolean {
  // A decoded path can hold any character, including line separators.
  const match = /^\/(?:server|app|relay)\/[^/]+\/files(?:\/(.*))?$/su.exec(
    urlPath
  )
  if (!match) return false
  if (path === undefined) return true
  const shown = match[1] ?? ""
  const expected = trimSlashes(path)
  if (trimSlashes(shown) === expected) return true
  return Result.match(
    Result.try(() => decodeURIComponent(shown)),
    {
      onSuccess: (decoded) => trimSlashes(decoded) === expected,
      onFailure: () => false,
    }
  )
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/gu, "")
}
