import { queryOptions } from "@tanstack/react-query"
import { getMyInvitations } from "@/server/resource-access"

export type ResourceInvitation = Awaited<
  ReturnType<typeof getMyInvitations>
>[number]
export function myInvitationsQueryOptions() {
  return queryOptions({
    queryKey: ["my-resource-invitations"],
    queryFn: () => getMyInvitations(),
    staleTime: 5_000,
    refetchInterval: 15_000,
  })
}
export function invitationInfrastructureHref(
  invitation: Pick<ResourceInvitation, "id" | "scope">
) {
  const section =
    invitation.scope.resourceType === "instance"
      ? "servers"
      : invitation.scope.resourceType === "database"
        ? "databases"
        : "relays"
  return `/infra/${section}?invitation=${encodeURIComponent(invitation.id)}`
}
