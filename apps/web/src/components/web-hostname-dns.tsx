import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { resourceWebHostnamesQueryOptions } from "@/lib/query-options"
import type { ResourceWebHostname } from "@/server/domains"

export interface WebHostnameResourceRef {
  relayId: string
  resourceId: string
  resourceType: "app" | "instance"
}

/**
 * Whether Kiln keeps a web route hostname's DNS record, beside the route.
 * Nothing shows for a hostname it doesn't manage: its owner points it at the
 * Relay.
 */
export const WebHostnameDnsStatus = React.memo(function WebHostnameDnsStatus({
  hostname,
  resource,
}: {
  hostname: string
  resource: WebHostnameResourceRef
}) {
  const selectHostname = React.useCallback(
    (rows: Array<ResourceWebHostname>) =>
      rows.find((row) => row.hostname === hostname) ?? null,
    [hostname]
  )
  const { data: row } = useQuery({
    ...resourceWebHostnamesQueryOptions(
      resource.relayId,
      resource.resourceType,
      resource.resourceId
    ),
    select: selectHostname,
  })
  if (!row) return null
  const presentation = dnsPresentation(row)
  const Icon = presentation.icon
  const label = (
    <span
      className={`type-meta inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${presentation.className}`}
    >
      <Icon
        aria-hidden
        className={`size-3 ${row.status === "pending" ? "animate-spin" : ""}`}
      />
      {presentation.label}
    </span>
  )
  return row.lastError ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{label}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{row.lastError}</TooltipContent>
    </Tooltip>
  ) : (
    label
  )
})

function dnsPresentation(row: ResourceWebHostname) {
  switch (row.status) {
    case "active":
      return {
        className: "text-emerald-700 dark:text-emerald-300",
        icon: CircleCheck,
        label: "DNS by Kiln",
      }
    case "pending":
      return {
        className: "text-muted-foreground",
        icon: LoaderCircle,
        label: "Creating DNS",
      }
    case "external":
      return {
        className: "text-amber-700 dark:text-amber-300",
        icon: CircleAlert,
        label: "Existing DNS record",
      }
    case "removing":
      return {
        className: "text-destructive",
        icon: CircleAlert,
        label: "DNS delete failed",
      }
    default:
      return {
        className: "text-destructive",
        icon: CircleAlert,
        label: "DNS error",
      }
  }
}

/** The address Kiln generated for an app, if it has one. */
export function useGeneratedHostname(resource: WebHostnameResourceRef) {
  const { data } = useQuery({
    ...resourceWebHostnamesQueryOptions(
      resource.relayId,
      resource.resourceType,
      resource.resourceId
    ),
    select: selectGenerated,
  })
  return data ?? null
}

function selectGenerated(rows: Array<ResourceWebHostname>) {
  return rows.find((row) => row.generated) ?? null
}
