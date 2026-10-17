import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@workspace/ui/lib/utils"
import {
  BrickIcon,
  brickIconPresentation,
  type BrickIconDefinition,
} from "@/components/brick-icon"
import { brickIconPresentationsQueryOptions } from "@/lib/query-options"

export const LiveServerBrickIcon = React.memo(function LiveServerBrickIcon({
  brickId,
  brickSource,
  className,
  implementation,
}: {
  brickId?: string
  brickSource?: string
  className?: string
  implementation: string
}) {
  const selectIcon = React.useCallback(
    (bricks: Array<BrickIconDefinition>) =>
      brickIconPresentation(bricks, {
        brickId,
        brickSource,
        implementation,
      }),
    [brickId, brickSource, implementation]
  )
  const { data: icon } = useQuery({
    ...brickIconPresentationsQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectIcon,
  })
  return (
    <BrickIcon
      id={icon?.id ?? brickId ?? implementation}
      color={icon?.color}
      iconSvg={icon?.iconSvg}
      className={cn("size-6", className)}
      aria-hidden="true"
    />
  )
})
