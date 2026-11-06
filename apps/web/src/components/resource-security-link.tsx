import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"

import { InfoRailLink, InfoRailRow } from "@/components/info-page"
import { VerdictBadge } from "@/components/security-severity"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import {
  securityScopeKey,
  securityVerdictReason,
  type SecurityTarget,
} from "@/lib/security"
import { resourceSecurityQueryOptions } from "@/lib/security-queries"

function selectPlatformAdmin(capabilities: { isPlatformAdmin: boolean }) {
  return capabilities.isPlatformAdmin
}

/**
 * A resource's Info rail row: Kiln's word on what it runs. The row is always
 * there, so what it finds never moves the page. For administrators it opens
 * the Security page on this instance; that page isn't open to anyone else.
 */
export const InfoRailSecurityLink = React.memo(function InfoRailSecurityLink({
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
  const { data: platformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectPlatformAdmin,
  })
  const detail = data ? (
    <span title={securityVerdictReason(data)}>
      <VerdictBadge verdict={data.verdict} />
    </span>
  ) : data === null ? (
    "Not checked"
  ) : null
  return platformAdmin ? (
    <InfoRailLink
      to="/kiln/security"
      search={{ scope }}
      preload="intent"
      detail={detail}
      leading={<ShieldCheck />}
    >
      Security
    </InfoRailLink>
  ) : (
    <InfoRailRow detail={detail} leading={<ShieldCheck />}>
      Security
    </InfoRailRow>
  )
})
