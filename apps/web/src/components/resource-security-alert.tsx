import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ShieldAlert, Siren } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { SeverityCountChips } from "@/components/security-severity"
import { securityScopeKey, type SecurityTarget } from "@/lib/security"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { resourceSecurityQueryOptions } from "@/lib/security-queries"

function selectPlatformAdmin(capabilities: { isPlatformAdmin: boolean }) {
  return capabilities.isPlatformAdmin
}

/**
 * Warns on a resource's page when what it runs has critical or high
 * vulnerabilities, or ones known to be exploited, and says what fixes them.
 * Says nothing otherwise: lesser findings are on Kiln's Security page.
 */
export const ResourceSecurityAlert = React.memo(function ResourceSecurityAlert({
  relayId,
  resourceId,
  resourceType,
}: {
  relayId: string
  resourceId: string
  resourceType: SecurityTarget["resourceType"]
}) {
  const scope = securityScopeKey(resourceType, relayId, resourceId)
  const { data } = useQuery(resourceSecurityQueryOptions(scope))
  // Kiln's Security page is for platform administrators.
  const { data: platformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectPlatformAdmin,
  })
  if (
    !data ||
    (data.counts.critical === 0 &&
      data.counts.high === 0 &&
      data.knownExploited === 0)
  ) {
    return null
  }
  const top = data.top[0]
  const urgent = data.knownExploited > 0 || data.counts.critical > 0
  const subject =
    resourceType === "relay"
      ? "This Relay's host or Kiln's services on it"
      : resourceType === "app"
        ? "This app's image"
        : resourceType === "database"
          ? "This database's image"
          : "This game server's image"
  return (
    <section
      role="status"
      className={cn(
        "flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center",
        urgent
          ? "border-red-500/30 bg-red-500/8 light:bg-red-500/6"
          : "border-orange-500/30 bg-orange-500/8 light:bg-orange-500/6"
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg border",
          urgent
            ? "border-red-500/35 text-red-300 light:text-red-700"
            : "border-orange-500/35 text-orange-300 light:text-orange-700"
        )}
      >
        {data.knownExploited > 0 ? (
          <Siren className="size-4" />
        ) : (
          <ShieldAlert className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="type-card-title">{subject} has known vulnerabilities</p>
          <SeverityCountChips counts={data.counts} />
        </div>
        <p className="type-meta mt-0.5 text-muted-foreground">
          {data.knownExploited > 0
            ? `${data.knownExploited} ${data.knownExploited === 1 ? "is" : "are"} being exploited in the wild. `
            : ""}
          {top
            ? `${top.vulnerabilityId} in ${top.packageName} ${top.installedVersions.join(", ")}${top.fixedVersion ? ` is fixed in ${top.fixedVersion}` : ""}. `
            : ""}
          {data.fixable > 0
            ? resourceType === "relay"
              ? "Updating the host's packages or Kiln fixes "
              : "Updating to a newer image fixes "
            : ""}
          {data.fixable > 0
            ? `${data.fixable === data.counts.critical + data.counts.high + data.counts.medium + data.counts.low + data.counts.negligible ? "all" : data.fixable} of them.`
            : "No fix is out yet."}
        </p>
      </div>
      {platformAdmin ? (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to="/kiln/security" search={{ scope }}>
            Review
          </Link>
        </Button>
      ) : null}
    </section>
  )
})
