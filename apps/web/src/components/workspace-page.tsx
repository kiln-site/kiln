import type { ReactNode } from "react"

/**
 * A workspace page: an optional summary card above content that fills the
 * rest of the page, such as a data table.
 */
export function WorkspacePage({
  children,
  summary,
}: {
  children: ReactNode
  summary?: ReactNode
}) {
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      {summary ? <div className="mb-3 shrink-0">{summary}</div> : null}
      {children}
    </div>
  )
}
