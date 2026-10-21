import { cn } from "@workspace/ui/lib/utils"

import type { BrandMarkDefinition } from "~/lib/brand-marks"

// A brand's mark from brand-marks.ts, in its own colour.
export function BrandSvg({
  className,
  mark,
}: {
  className: string
  mark: BrandMarkDefinition
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox={mark.viewBox}
      fill={mark.color}
      className={cn("shrink-0", className)}
    >
      <path d={mark.path} fillRule={mark.fillRule} />
    </svg>
  )
}
