import { Progress } from "@workspace/ui/components/progress"
import { cn } from "@workspace/ui/lib/utils"

// One labeled bar in a rail card's summary, such as a node's RAM or a
// container's memory limit.
export function UsageBar({
  detail,
  indicatorClassName,
  label,
  title,
  total,
  used,
  value,
}: {
  detail?: string
  // Colors the bar, as a class on the progress root.
  indicatorClassName: string
  label: string
  title?: string
  // Usage and capacity use the same units. For CPU, 100% is one core.
  total: number | undefined
  used: number | undefined
  value: string
}) {
  const percent =
    used !== undefined && total !== undefined && total > 0
      ? (used / total) * 100
      : 0
  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate tabular-nums">
          {value}
          {detail ? (
            <span className="ml-1 text-muted-foreground">{detail}</span>
          ) : null}
        </span>
      </div>
      <Progress
        aria-label={label}
        className={cn("mt-1.5 h-1.5", indicatorClassName)}
        value={Math.min(100, Math.max(0, percent))}
      />
    </div>
  )
}
