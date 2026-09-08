import { memo, useMemo, useState, useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { Clock3 } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { ResourceInvitationDialog } from "@/components/resource-invitation-dialog"
import type { DataTableSearchStore } from "@/lib/data-table-search"
import {
  myInvitationsQueryOptions,
  type ResourceInvitation,
} from "@/lib/resource-invitation-query"

// An independent body under the existing inventory header. Dialog changes do
// not update the inventory query, table model, or virtualized active rows.
export const PendingResourceInvitations = memo(
  function PendingResourceInvitations({
    resourceType,
    searchStore,
    visibleResourceKeys,
  }: {
    resourceType: "instance" | "database" | "relay"
    searchStore: DataTableSearchStore
    visibleResourceKeys: ReadonlySet<string>
  }) {
    const search = useSyncExternalStore(
      searchStore.subscribe,
      searchStore.getNormalizedSnapshot,
      searchStore.getNormalizedServerSnapshot
    )
    const select = useMemo(
      () => (rows: Array<ResourceInvitation>) =>
        rows.filter((row) => row.scope.resourceType === resourceType),
      [resourceType]
    )
    const query = useQuery({ ...myInvitationsQueryOptions(), select })
    const routeInvitation = useRouterState({
      select: (state) =>
        new URLSearchParams(state.location.searchStr).get("invitation"),
    })
    const routeSearch = useRouterState({
      select: (state) =>
        new URLSearchParams(state.location.searchStr)
          .get("search")
          ?.toLowerCase(),
    })
    const [selected, setSelected] = useState<string | null>(null)
    const [dismissed, setDismissed] = useState<string | null>(null)
    const rows =
      query.data?.filter(
        (row) =>
          !visibleResourceKeys.has(
            resourceInvitationScopeKey(row.scope.relayId, row.scope.resourceId)
          ) &&
          (!search ||
            `${row.resourceName} ${row.scope.resourceId} ${row.scope.relayId}`
              .toLowerCase()
              .includes(search))
      ) ?? []
    const fromSearch = query.data?.find(
      (row) => row.scope.resourceId.toLowerCase() === (routeSearch || search)
    )?.id
    const requested = routeInvitation ?? fromSearch ?? null
    const active = selected ?? (requested !== dismissed ? requested : null)
    return (
      <>
        {rows.length ? (
          <tbody
            aria-label="Pending access"
            className="block max-h-56 shrink-0 overflow-y-auto border-b border-border/70 [&~[data-slot=data-table-state-body][data-empty=true]]:hidden"
          >
            {rows.map((invitation) => (
              <PendingRow
                key={invitation.id}
                invitation={invitation}
                onOpen={setSelected}
              />
            ))}
          </tbody>
        ) : null}
        {active ? (
          <ResourceInvitationDialog
            invitationId={active}
            onClose={() => {
              setDismissed(requested)
              setSelected(null)
            }}
          />
        ) : null}
      </>
    )
  }
)

const PendingRow = memo(function PendingRow({
  invitation,
  onOpen,
}: {
  invitation: ResourceInvitation
  onOpen: (id: string) => void
}) {
  const type = invitation.scope.resourceType
  return (
    <tr className="relative grid min-h-14 grid-cols-[var(--data-table-grid-base)] border-b border-border/70 bg-amber-500/[0.025] text-sm hover:bg-muted/20 sm:grid-cols-[var(--data-table-grid-sm)] md:grid-cols-[var(--data-table-grid-md)] lg:grid-cols-[var(--data-table-grid-lg)] xl:grid-cols-[var(--data-table-grid-xl)]">
      <td className="flex items-center px-2 text-xs text-amber-600 sm:px-3 dark:text-amber-400">
        <button
          type="button"
          onClick={() => onOpen(invitation.id)}
          aria-label={`Review invitation to ${invitation.resourceName}`}
          className="absolute inset-0 z-10 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        />
        <Clock3 className="mr-1 size-3.5" aria-hidden />
        <span className="hidden sm:inline">Pending</span>
      </td>
      <td className="pointer-events-none flex min-w-0 flex-col justify-center px-3">
        <span className="truncate font-medium">{invitation.resourceName}</span>
        <span className="truncate text-xs text-muted-foreground">
          Invited {invitation.createdAt.slice(0, 10)}
        </span>
      </td>
      <td className="pointer-events-none hidden min-w-0 items-center truncate px-3 text-xs text-muted-foreground md:flex">
        {type === "instance" ? invitation.relayName : "—"}
      </td>
      <td
        className={`pointer-events-none hidden min-w-0 items-center truncate px-3 text-xs text-muted-foreground ${type === "instance" ? "xl:flex" : type === "database" ? "md:flex" : "lg:flex"}`}
      >
        {type === "database" ? invitation.relayName : "—"}
      </td>
      {type === "relay" ? (
        <td className="pointer-events-none hidden items-center px-3 text-xs text-muted-foreground xl:flex">
          —
        </td>
      ) : null}
      <td className="pointer-events-none flex items-center justify-end px-3 text-xs font-medium text-primary">
        Review invitation
      </td>
    </tr>
  )
})

export function resourceInvitationScopeKey(
  relayId: string,
  resourceId: string
): string {
  return `${relayId}:${resourceId}`
}

// Only the matching badge subscribes to invitation changes. Inventory rows retain
// their normal navigation and authority while a second grant awaits acceptance.
export const PendingResourceInvitationBadge = memo(
  function PendingResourceInvitationBadge({
    resourceType,
    relayId,
    resourceId,
  }: {
    resourceType: "instance" | "database" | "relay"
    relayId: string
    resourceId: string
  }) {
    const select = useMemo(
      () => (rows: Array<ResourceInvitation>) =>
        rows.find(
          (row) =>
            row.scope.resourceType === resourceType &&
            row.scope.relayId === relayId &&
            row.scope.resourceId === resourceId
        ),
      [resourceType, relayId, resourceId]
    )
    const { data: invitation } = useQuery({
      ...myInvitationsQueryOptions(),
      select,
    })
    const [open, setOpen] = useState(false)
    if (!invitation) return null
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400"
              aria-label={`Review pending invitation to ${invitation.resourceName}`}
              onClick={(event) => {
                event.stopPropagation()
                setOpen(true)
              }}
            >
              <Clock3 aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Review pending invitation
          </TooltipContent>
        </Tooltip>
        {open ? (
          <ResourceInvitationDialog
            invitationId={invitation.id}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    )
  }
)
