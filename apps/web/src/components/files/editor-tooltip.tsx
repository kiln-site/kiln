import * as React from "react"

import { WorkspaceToolbarTooltip } from "@/components/workspace-toolbar-tooltip"

export function EditorTooltip({
  content,
  children,
}: {
  content: string
  children: React.ReactElement<{ disabled?: boolean }>
}) {
  return (
    <WorkspaceToolbarTooltip content={content} wrapDisabledTrigger>
      {children}
    </WorkspaceToolbarTooltip>
  )
}
