import { TriangleAlert } from "lucide-react"
import { Button } from "@workspace/ui/components/button"

import { ConsoleTooltip } from "./console-tooltip"

const warningIcon = <TriangleAlert className="size-3.5 shrink-0" />

/** A toolbar warning, optionally actionable (for example, retrying a stream). */
export function ConsoleWarning({
  message,
  label,
  action,
}: {
  message: string
  label: string
  action?: { onClick: () => void; text?: string }
}) {
  return (
    <ConsoleTooltip content={message}>
      {action ? (
        <Button
          aria-label={label}
          variant="ghost"
          size={action.text ? "sm" : "icon-sm"}
          className="text-amber-300 light:text-amber-700"
          onClick={action.onClick}
        >
          {warningIcon}
          {action.text}
        </Button>
      ) : (
        <span
          aria-label={label}
          className="inline-flex shrink-0 items-center text-amber-300 outline-none light:text-amber-700"
          role="status"
          tabIndex={0}
        >
          {warningIcon}
        </span>
      )}
    </ConsoleTooltip>
  )
}
