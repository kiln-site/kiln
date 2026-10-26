import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export function WorkspaceToolbarTooltip({
  content,
  children,
  wrapDisabledTrigger = false,
  keepOpen,
}: {
  content: string
  children: React.ReactElement<{ disabled?: boolean }>
  wrapDisabledTrigger?: boolean
  keepOpen?: boolean
}) {
  const [hovered, setHovered] = React.useState(false)
  const trigger =
    wrapDisabledTrigger && children.props.disabled ? (
      <span className="inline-flex max-w-full min-w-0">{children}</span>
    ) : (
      children
    )

  return (
    <Tooltip
      open={keepOpen === undefined ? undefined : hovered || keepOpen}
      onOpenChange={keepOpen === undefined ? undefined : setHovered}
    >
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
