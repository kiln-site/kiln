import { WrapText } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

export function WorkspaceLineWrapButton({
  ariaLabel,
  buttonClassName,
  iconClassName,
  onToggle,
  wrapLines,
}: {
  ariaLabel: string
  buttonClassName?: string
  iconClassName?: string
  onToggle: () => void
  wrapLines: boolean
}) {
  return (
    <Button
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
