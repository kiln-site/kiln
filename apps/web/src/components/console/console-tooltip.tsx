import * as React from "react"

import { WorkspaceToolbarTooltip } from "@/components/workspace-toolbar-tooltip"

export function ConsoleTooltip({
  content,
  children,
  keepOpen,
}: {
  content: string
  children: React.ReactElement<{ disabled?: boolean }>
  keepOpen?: boolean
}) {
  return (
    <WorkspaceToolbarTooltip content={content} keepOpen={keepOpen}>
      {children}
    </WorkspaceToolbarTooltip>
  )
}
