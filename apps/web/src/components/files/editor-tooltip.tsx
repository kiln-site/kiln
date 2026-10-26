import * as React from "react"

import { WorkspaceToolbarTooltip } from "@/components/workspace-toolbar-tooltip"

export function EditorTooltip({
  content,
  children,
  keepOpen,
}: {
  content: string
  children: React.ReactElement<{ disabled?: boolean }>
  keepOpen?: boolean
}) {
  return (
    <WorkspaceToolbarTooltip
      content={content}
      wrapDisabledTrigger
      keepOpen={keepOpen}
    >
      {children}
    </WorkspaceToolbarTooltip>
  )
}
