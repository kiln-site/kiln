import * as React from "react"
import { Star } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Marks which of an instance's domains or join addresses is its primary
 * one: the one its header and lists show. Pressing another's makes it so.
 */
export const PrimaryStar = React.memo(function PrimaryStar({
  disabled,
  name,
  noun,
  primary,
  onMakePrimary,
}: {
  disabled: boolean
  name: string
  noun: "address" | "domain"
  primary: boolean
  onMakePrimary: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={
            primary
              ? `${name} is the primary ${noun}`
              : `Make ${name} the primary ${noun}`
          }
          aria-pressed={primary}
          className={cn(
            primary
              ? "text-primary-ink hover:text-primary-ink"
              : "text-muted-foreground/70 hover:text-primary-ink"
          )}
          disabled={disabled && !primary}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => {
            if (!primary) onMakePrimary()
          }}
        >
          <Star className={cn(primary && "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {primary ? `Primary ${noun}` : "Make primary"}
      </TooltipContent>
    </Tooltip>
  )
})
