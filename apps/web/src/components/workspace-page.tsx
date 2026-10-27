import type { ReactNode } from "react"

import { cn } from "@workspace/ui/lib/utils"

/**
 * A workspace page: a summary above content that fills the rest of the page,
 * such as a data table, with an optional rail on the right. The summary
 * brings its own spacing, as the scope pickers do.
 */
export function WorkspacePage({
  children,
  rail,
  railClassName,
  summary,
}: {
  children: ReactNode
  rail?: ReactNode
  /** Such as a wider rail for a list of long names. */
  railClassName?: string
  summary?: ReactNode
}) {
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col gap-3 px-2 pb-3 sm:px-5 sm:pb-5 xl:flex-row">
      <div className="flex min-h-[28rem] min-w-0 flex-1 flex-col xl:min-h-0">
        {summary}
        {children}
      </div>
      {rail ? (
        // Beside the content on wide screens, below it otherwise. Rail labels
        // are short, so they take only their width and leave the rest to
        // values.
        <aside
          className={cn(
            "min-w-0 shrink-0 rounded-xl border border-border/75 bg-card/45 p-4 xl:flex xl:w-72 xl:flex-col xl:overflow-y-auto [&_dt]:min-w-0",
            railClassName
          )}
        >
          {rail}
        </aside>
      ) : null}
    </div>
  )
}
