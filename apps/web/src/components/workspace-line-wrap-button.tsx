import * as React from "react"
import { WrapText } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

type WorkspaceLineWrapButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  | "aria-label"
  | "aria-pressed"
  | "children"
  | "className"
  | "onClick"
  | "size"
  | "variant"
> & {
  ariaLabel: string
  buttonClassName?: string
  iconClassName?: string
  onToggle: () => void
  wrapLines: boolean
}

export function WorkspaceLineWrapButton({
  ariaLabel,
  buttonClassName,
  iconClassName,
  onToggle,
  wrapLines,
  ...buttonProps
}: WorkspaceLineWrapButtonProps) {
  return (
    <Button
      {...buttonProps}
      variant={wrapLines ? "secondary" : "ghost"}
      size="icon"
      className={buttonClassName}
      aria-label={ariaLabel}
      aria-pressed={wrapLines}
      onClick={onToggle}
    >
      <WrapText className={iconClassName} />
    </Button>
  )
}
