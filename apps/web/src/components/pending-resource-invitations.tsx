import {
  memo,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter, useRouterState } from "@tanstack/react-router"
import { ChevronRight, Clock3 } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { dataTableCellClassName } from "@/components/data-table"
import { InstanceCard } from "@/components/instance-card"
import { ResourceInvitationDialog } from "@/components/resource-invitation-dialog"
import type { DataTableColumnMeta } from "@/lib/data-table"
import type { DataTableSearchStore } from "@/lib/data-table-search"
import {
  myInvitationsQueryOptions,
  type ResourceInvitation,
} from "@/lib/resource-invitation-query"

export type PendingInvitationCells = Readonly<
  Partial<Record<string, (invitation: ResourceInvitation) => ReactNode>>
>
type PendingInvitationColumns = ReadonlyArray<{
  id?: string
  meta?: DataTableColumnMeta
}>

// An independent body under the existing inventory header. Dialog changes do
// not update the inventory query, table model, or virtualized active rows.
export const PendingResourceInvitations = memo(
  function PendingResourceInvitations({
    cells,
    columns,
    resourceType,
    searchStore,
    visibleResourceKeys,
  }: {
    // A pending row renders the table's own columns. Status and actions hold
    // the invitation; the rest show what each cell renders for it.
    cells: PendingInvitationCells
    columns: PendingInvitationColumns
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
    const router = useRouter()
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
    // Only a deep link opens the dialog. Typing an id into the table's own
    // search box should filter the list, not pop a modal mid-keystroke.
    const fromRouteSearch = routeSearch
      ? query.data?.find(
          (row) => row.scope.resourceId.toLowerCase() === routeSearch
        )?.id
      : undefined
    const requested = routeInvitation ?? fromRouteSearch ?? null
    const active = selected ?? (requested !== dismissed ? requested : null)
    return (
      <>
        {rows.length ? (
          <tbody
            aria-label="Pending access"
            className="block max-h-56 shrink-0 overflow-y-auto border-b border-border/70 [&~[data-slot=data-table-state-body][data-empty=true]]:hidden"
            role="rowgroup"
          >
            {rows.map((invitation) => (
              <PendingRow
                key={invitation.id}
                cells={cells}
                columns={columns}
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
              // A decided invitation must not reopen on reload. Read the
              // location from the router on demand so this body does not
              // subscribe to every navigation.
              if (routeInvitation) {
                const url = new URL(
                  router.state.location.href,
                  window.location.origin
                )
                url.searchParams.delete("invitation")
                void router.navigate({
                  replace: true,
                  href: `${url.pathname}${url.search}${url.hash}`,
                })
              }
            }}
          />
        ) : null}
      </>
    )
  }
)

const PendingRow = memo(function PendingRow({
  cells,
  columns,
  invitation,
  onOpen,
}: {
  cells: PendingInvitationCells
  columns: PendingInvitationColumns
  invitation: ResourceInvitation
  onOpen: (id: string) => void
}) {
  // A raised detail, like a tooltip trigger, still opens the invitation when
  // clicked. A button of its own, like the email's reveal, keeps its action.
  const openFromDetail = (event: MouseEvent<HTMLTableCellElement>) => {
    if (!(event.target as Element).closest("button")) onOpen(invitation.id)
  }
  return (
    <tr
      className="relative grid grid-cols-[var(--data-table-grid-base)] border-b border-border/70 bg-amber-500/[0.025] text-sm hover:bg-muted/20 sm:grid-cols-[var(--data-table-grid-sm)] md:grid-cols-[var(--data-table-grid-md)] lg:grid-cols-[var(--data-table-grid-lg)] xl:grid-cols-[var(--data-table-grid-xl)]"
      role="row"
    >
      {columns.map((column, index) => {
        const className = dataTableCellClassName(column.meta)
        if (column.id === "status") {
          return (
            <td
              key={column.id}
              className={cn(
                className,
                "text-xs text-amber-600 dark:text-amber-400"
              )}
              role="cell"
            >
              <Clock3 className="mr-1 size-3.5 shrink-0" aria-hidden />
              <span className="hidden sm:inline">Pending</span>
            </td>
          )
        }
        // The row's button covers the whole row. It sits in the actions cell,
        // which every table shows on phones, where the status column hides.
        if (column.id === "actions") {
          return (
            <td
              key={column.id}
              className={cn(
                className,
                "justify-end text-xs font-medium text-primary-ink"
              )}
              role="cell"
            >
              <button
                type="button"
                onClick={() => onOpen(invitation.id)}
                aria-label={`Review invitation to ${invitation.resourceName}`}
                className="absolute inset-0 z-10 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
              <span aria-hidden className="hidden md:inline">
                Review invitation
              </span>
              <ChevronRight aria-hidden className="size-4 md:hidden" />
            </td>
          )
        }
        return (
          <td
            key={column.id ?? index}
            className={cn(className, "pointer-events-none")}
            role="cell"
            onClick={openFromDetail}
          >
            {column.id ? cells[column.id]?.(invitation) : null}
          </td>
        )
      })}
    </tr>
  )
})

/**
 * Lifts a pending row's detail, such as a tooltip trigger or a blurred email,
 * above the row's button so it still takes the pointer. Clicking it opens the
 * invitation unless it's a button of its own.
 */
export const pendingRowDetailClassName = "pointer-events-auto relative z-20"

const pendingInvitationStatus = {
  label: "Pending invitation",
  tone: "warning",
} as const

/** The resource's identity card for its pending row, marked pending. */
export const PendingInvitationCard = memo(function PendingInvitationCard({
  invitation,
}: {
  invitation: ResourceInvitation
}) {
  const type = invitation.scope.resourceType
  return (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={{
        id: invitation.scope.resourceId,
        kind: type === "instance" ? "server" : type,
        relayId: invitation.scope.relayId,
      }}
      meta={`Invited ${invitation.createdAt.slice(0, 10)}`}
      name={invitation.resourceName}
      showFavorite={false}
      status={pendingInvitationStatus}
    />
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
              className="relative z-10 shrink-0 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400 light:hover:bg-amber-500/20"
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
