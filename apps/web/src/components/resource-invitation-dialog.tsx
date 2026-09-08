import { useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"
import { permissionCatalog } from "@workspace/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
    onSuccess: async (result) => {
      queryClient.setQueryData(
        myInvitationsQueryOptions().queryKey,
        (previous: Array<ResourceInvitation> | undefined) =>
          previous?.filter((item) => item.id !== invitationId)
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: myInvitationsQueryOptions().queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: accessCapabilitiesQueryOptions().queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: ["resource-invitation", invitationId],
        }),
      ])
      showToast({
        type: "success",
        message: result.accepted
          ? "Invitation accepted"
          : "Invitation declined",
      })
      onClose()
      if (!result.accepted) return
      if (result.scope.resourceType === "instance") {
        await queryClient.invalidateQueries({
          queryKey: relayConnectionQueryOptions(queryClient).queryKey,
        })
        const [capabilities, connection] = await Promise.all([
          queryClient.fetchQuery(accessCapabilitiesQueryOptions()),
          queryClient.fetchQuery(relayConnectionQueryOptions(queryClient)),
        ])
        const snapshot =
          connection.status === "connected" ||
          connection.status === "unreachable"
            ? connection.snapshot
            : null
        const instance = snapshot?.instances.find(
          (candidate) =>
            candidate.relayId === result.scope.relayId &&
            candidate.id === result.scope.resourceId
        )
        if (instance) {
          const destination = accessibleDestinationsForServer(
            instance,
            capabilities
          )[0]
          const routeId = relayInstanceRouteIdentifier(
            snapshot!.instances,
            instance
          )
          if (destination && routeId) {
            await navigate({
              href: serverDestinationHref(destination, routeId),
            })
            return
          }
        }
      }
      const section =
        result.scope.resourceType === "database"
          ? "databases"
          : result.scope.resourceType === "relay"
            ? "relays"
            : "servers"
      await queryClient.invalidateQueries({
        queryKey:
          result.scope.resourceType === "database"
            ? queryKeys.databases.list
            : queryKeys.relays,
      })
      await navigate({
        href: `/infra/${section}?search=${encodeURIComponent(result.scope.resourceId)}`,
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
            <dd>{date(invitation.data.createdAt)}</dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{date(invitation.data.expiresAt)}</dd>
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
function date(value: string) {
  return `${value.slice(0, 16).replace("T", " ")} UTC`
}
