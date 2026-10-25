import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import {
  securitySeverityLabels,
  type SecuritySeverity,
  type SeverityCounts,
} from "@/lib/security"

// How severities look wherever Kiln shows a vulnerability.

const severityClasses = {
  critical:
    "border-red-500/35 bg-red-500/12 text-red-300 light:bg-red-500/10 light:text-red-700",
  high: "border-orange-500/35 bg-orange-500/12 text-orange-300 light:bg-orange-500/10 light:text-orange-700",
  medium:
    "border-amber-400/35 bg-amber-400/10 text-amber-200 light:bg-amber-400/15 light:text-amber-800",
  low: "border-sky-400/30 bg-sky-400/10 text-sky-200 light:bg-sky-400/10 light:text-sky-800",
  negligible: "border-border bg-muted/40 text-muted-foreground",
} satisfies Record<SecuritySeverity, string>

export const SeverityBadge = React.memo(function SeverityBadge({
  className,
  severity,
}: {
  className?: string
  severity: SecuritySeverity
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[0.6875rem] font-medium",
        severityClasses[severity],
        className
      )}
    >
      {securitySeverityLabels[severity]}
    </span>
  )
})

const shownSeverities = ["critical", "high", "medium", "low"] as const

/** Counts of each severity found, leaving out those with none. */
export const SeverityCountChips = React.memo(function SeverityCountChips({
  counts,
  empty = "None found",
}: {
  counts: SeverityCounts
  empty?: React.ReactNode
}) {
  const shown = shownSeverities.filter((severity) => counts[severity] > 0)
  if (!shown.length) {
    return <span className="type-meta text-muted-foreground">{empty}</span>
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((severity) => (
        <span
          key={severity}
          title={`${counts[severity]} ${securitySeverityLabels[severity].toLowerCase()}`}
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[0.6875rem] font-medium tabular-nums",
            severityClasses[severity]
          )}
        >
          {counts[severity]}
          <span className="font-normal opacity-80">
            {securitySeverityLabels[severity].charAt(0)}
          </span>
        </span>
      ))}
    </span>
  )
})

export function severityTone(severity: SecuritySeverity): string {
  return severityClasses[severity]
}
