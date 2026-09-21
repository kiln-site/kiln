import { useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"
import { permissionCatalog } from "@workspace/contracts"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import {
  getResourceInvitation,
  decideResourceInvitation,
} from "@/server/resource-access"
import {
  accessCapabilitiesQueryOptions,
  relayConnectionQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  accessibleDestinationsForServer,
  serverDestinationHref,
} from "@/lib/navigation-destinations"
import { relayInstanceRouteIdentifier } from "@/lib/relay-selectors"
import { utcTimestamp } from "@/components/access-format"
import {
  myInvitationsQueryOptions,
  type ResourceInvitation,
} from "@/lib/resource-invitation-query"

export function ResourceInvitationDialog({
  invitationId,
  onClose,
}: {
  invitationId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const invitation = useQuery({
    queryKey: ["resource-invitation", invitationId],
    queryFn: () => getResourceInvitation({ data: { id: invitationId } }),
  })
  const offeredPermissions = useMemo(() => {
    const keys = new Set(invitation.data?.permissions)
    return permissionCatalog.filter(
      (permission) => !permission.compatibilityOnly && keys.has(permission.key)
    )
  }, [invitation.data?.permissions])
  const decision = useMutation({
    mutationFn: (value: "accept" | "decline") =>
      decideResourceInvitation({
        data: { id: invitationId, decision: value, force: false },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(
        myInvitationsQueryOptions().queryKey,
        (previous: Array<ResourceInvitation> | undefined) =>
          previous?.filter((item) => item.id !== invitationId)
      )
      onClose()
      showToast({
        type: "success",
        message: result.accepted
          ? "Invitation accepted"
          : "Invitation declined",
      })
      // Navigate from whatever the cache already holds. Awaiting a capability
      // fetch and a full fleet snapshot before moving left the accept button
      // spinning for the length of a Relay round trip; the refreshed data
      // lands on the destination page instead.
      if (result.accepted)
        void navigate({
          href: acceptedDestination(queryClient, result.scope),
        })
      void queryClient.invalidateQueries({
        queryKey: myInvitationsQueryOptions().queryKey,
      })
      void queryClient.invalidateQueries({
        queryKey: accessCapabilitiesQueryOptions().queryKey,
      })
      void queryClient.invalidateQueries({
        queryKey: ["resource-invitation", invitationId],
      })
      if (!result.accepted) return
      void queryClient.invalidateQueries({
        queryKey:
          result.scope.resourceType === "database"
            ? queryKeys.databases.list
            : queryKeys.relays,
      })
      if (result.scope.resourceType === "instance")
        void queryClient.invalidateQueries({
          queryKey: relayConnectionQueryOptions(queryClient).queryKey,
        })
    },
    onError: (cause) => showToast({ type: "error", message: cause.message }),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !decision.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {invitation.data?.resourceName ?? "Resource invitation"}
          </DialogTitle>
          <DialogDescription>
            Accept this invitation to activate its access. Declining leaves your
            other assignments unchanged.
          </DialogDescription>
        </DialogHeader>
        {invitation.isPending ? (
          <p className="text-sm text-muted-foreground">Loading invitation…</p>
        ) : null}
        {invitation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {invitation.error.message}
          </p>
        ) : null}
        {invitation.data ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm [&>dd]:min-w-0 [&>dd]:break-words">
            <dt className="text-muted-foreground">Invited by</dt>
            <dd>{invitation.data.inviterName}</dd>
            <dt className="text-muted-foreground">Relay</dt>
            <dd>{invitation.data.relayName}</dd>
            <dt className="text-muted-foreground">For</dt>
            <dd>{invitation.data.email}</dd>
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="capitalize">{invitation.data.scope.resourceType}</dd>
            <dt className="text-muted-foreground">Invited</dt>
            <dd>{utcTimestamp(invitation.data.createdAt)}</dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{utcTimestamp(invitation.data.expiresAt)}</dd>
          </dl>
        ) : null}
        {invitation.data ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Offered permissions</h3>
            {invitation.data.presetNames.length ? (
              <p className="text-xs text-muted-foreground">
                Presets: {invitation.data.presetNames.join(", ")}
              </p>
            ) : null}
            <ul className="grid max-h-48 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto text-xs text-muted-foreground">
              {offeredPermissions.map((permission) => (
                <li key={permission.key}>{permission.label}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {invitation.data && !invitation.data.pending ? (
          <p className="text-sm text-muted-foreground">
            This invitation is no longer pending.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={decision.isPending}
          >
            Close
          </Button>
          <Button
            variant="outline"
            disabled={!invitation.data?.pending || decision.isPending}
            onClick={() => decision.mutate("decline")}
          >
            Decline
          </Button>
          <Button
            disabled={!invitation.data?.pending || decision.isPending}
            onClick={() => decision.mutate("accept")}
          >
            {decision.isPending ? "Updating…" : "Accept invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
type DecidedScope = Awaited<
  ReturnType<typeof decideResourceInvitation>
>["scope"]

// Prefer the server's own workspace when the cached fleet snapshot can already
// resolve it. Otherwise send the user to the matching inventory list filtered
// to the resource, which resolves once the invalidated queries settle.
function acceptedDestination(
  queryClient: QueryClient,
  scope: DecidedScope
): string {
  if (scope.resourceType === "instance") {
    const connection = queryClient.getQueryData(
      relayConnectionQueryOptions(queryClient).queryKey
    )
    const capabilities = queryClient.getQueryData(
      accessCapabilitiesQueryOptions().queryKey
    )
    const snapshot =
      connection?.status === "connected" || connection?.status === "unreachable"
        ? connection.snapshot
        : null
    const instance = snapshot?.instances.find(
      (candidate) =>
        candidate.relayId === scope.relayId && candidate.id === scope.resourceId
    )
    if (snapshot && instance && capabilities) {
      const destination = accessibleDestinationsForServer(
        instance,
        capabilities
      )[0]
      const routeId = relayInstanceRouteIdentifier(snapshot.instances, instance)
      if (destination && routeId)
        return serverDestinationHref(destination, routeId)
    }
  }
  const section =
    scope.resourceType === "database"
      ? "databases"
      : scope.resourceType === "relay"
        ? "relays"
        : "servers"
  return `/infra/${section}?search=${encodeURIComponent(scope.resourceId)}`
}
