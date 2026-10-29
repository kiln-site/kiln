import { instanceInventoryScope } from "@/lib/instance-inventory"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Network } from "lucide-react"

import type {
  DatabaseConnectionMember,
  DatabaseConnectionMemberKind,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  engineLabel,
  showDatabaseOperationError,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { appRouteIdentifier } from "@/lib/app-route"
import { databaseRouteIdentifier } from "@/lib/database-route"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { relayInstanceRouteIdentifier } from "@/lib/relay-selectors"
import { updateManagedDatabaseNetwork } from "@/server/databases"

type NetworkDatabase = Pick<
  ManagedDatabase,
  "id" | "name" | "relayId" | "relayName"
>

export const databaseMemberKey = (
  member: Pick<DatabaseConnectionMember, "id" | "kind">
) => `${member.kind}:${member.id}`

/** Something on the database's Relay that can join its network. */
export interface DatabaseMemberCandidate {
  /** Whether the user may connect or disconnect it. */
  canChange: boolean
  item: InstancePickerItem
  member: DatabaseConnectionMember
  /** Its page's route ID, when known. */
  routeId: string | null
}

const kindOrder: Record<DatabaseConnectionMemberKind, number> = {
  instance: 0,
  app: 1,
  database: 2,
}

/**
 * Game servers, Apps, and other databases on the database's Relay, by
 * member key, with whether the user may change their connection to it:
 * that takes the member's own network permission as well.
 */
export function useDatabaseMemberCandidates(
  database: Pick<NetworkDatabase, "id" | "relayId">
): ReadonlyMap<string, DatabaseMemberCandidate> {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { data: instances } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: (snapshot) => snapshot.instances,
  })
  const { data: apps } = useQuery(appDirectoryQueryOptions())
  const { data: databases } = useQuery(managedDatabaseDirectoryQueryOptions())
  return React.useMemo(() => {
    const candidates: Array<DatabaseMemberCandidate> = []
    const relayInstances = (instances ?? []).filter(
      (instance) => instance.relayId === database.relayId
    )
    for (const instance of relayInstances) {
      candidates.push({
        canChange: canAccessInstancePermission(
          capabilities,
          instance,
          "instance.network.write"
        ),
        item: {
          identity: {
            brickId: instance.brickId,
            brickSource: instance.brickSource,
            id: instance.id,
            implementation: instance.implementation,
            kind: "server",
            observedState: instance.observedState,
            relayId: instance.relayId,
          },
          key: databaseMemberKey({ id: instance.id, kind: "instance" }),
          meta: `${instance.implementation} ${instance.version} · ${instance.shortId}`,
          name: instance.name,
          searchText: `${instance.id} ${instance.relayName}`,
        },
        member: { id: instance.id, kind: "instance" },
        routeId: relayInstanceRouteIdentifier(relayInstances, instance) ?? null,
      })
    }
    for (const app of apps ?? []) {
      if (app.relayId !== database.relayId) continue
      candidates.push({
        canChange: app.permissions.includes("app.manage"),
        item: {
          identity: { id: app.id, kind: "app", relayId: app.relayId },
          key: databaseMemberKey({ id: app.id, kind: "app" }),
          meta: `App · ${app.shortId}`,
          name: app.name,
          searchText: app.id,
        },
        member: { id: app.id, kind: "app" },
        routeId: appRouteIdentifier(apps ?? [], app),
      })
    }
    for (const other of databases ?? []) {
      if (other.relayId !== database.relayId || other.id === database.id)
        continue
      candidates.push({
        canChange: other.permissions.includes("database.network.write"),
        item: {
          identity: { id: other.id, kind: "database", relayId: other.relayId },
          key: databaseMemberKey({ id: other.id, kind: "database" }),
          meta: `${engineLabel(other.engine)} · ${other.shortId}`,
          name: other.name,
          searchText: other.id,
        },
        member: { id: other.id, kind: "database" },
        routeId: databaseRouteIdentifier(databases ?? [], other),
      })
    }
    candidates.sort(
      (left, right) =>
        kindOrder[left.member.kind] - kindOrder[right.member.kind] ||
        left.item.name.localeCompare(right.item.name)
    )
    return new Map(
      candidates.map((candidate) => [candidate.item.key, candidate])
    )
  }, [apps, capabilities, database.id, database.relayId, databases, instances])
}

export function useDatabaseNetworkToggle(
  database: Pick<NetworkDatabase, "id" | "relayId">
) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: (input: {
      connected: boolean
      member: DatabaseConnectionMember
    }) =>
      updateManagedDatabaseNetwork({
        data: {
          ...input,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onSuccess: async (_database, { member }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({
            kind: "database",
            relayId: database.relayId,
            id: database.id,
          }),
        }),
        // An App's Network page lists the databases it's connected to.
        member.kind === "app"
          ? queryClient.invalidateQueries({
              queryKey: instanceInventoryScope({
                kind: "app",
                relayId: database.relayId,
                id: member.id,
              }),
            })
          : null,
      ])
    },
    onError: (error) =>
      showDatabaseOperationError("Network update failed", error),
  })
  return {
    pendingKey: update.isPending
      ? databaseMemberKey(update.variables.member)
      : null,
    toggle: update.mutate,
  }
}

export const DatabaseNetworkPicker = React.memo(function DatabaseNetworkPicker({
  database,
  onCloseAutoFocus,
  onOpenChange,
  open: controlledOpen,
  variant = "icon",
}: {
  database: NetworkDatabase
  onCloseAutoFocus?: (event: Event) => void
  /** Set both to open the picker from elsewhere, like a menu. */
  onOpenChange?: (open: boolean) => void
  open?: boolean
  variant?: "button" | "icon"
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const title = `Connect to ${database.name}`

  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      {variant === "button" ? (
        <DrawerPopoverTrigger asChild>
          <Button
            aria-expanded={open}
            size="sm"
            type="button"
            variant="outline"
          >
            <Network />
            Connect
          </Button>
        </DrawerPopoverTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DrawerPopoverTrigger asChild>
              <Button
                aria-label={title}
                aria-expanded={open}
                className="text-muted-foreground hover:text-primary-ink"
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Network />
              </Button>
            </DrawerPopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Connect game servers, Apps, and databases
          </TooltipContent>
        </Tooltip>
      )}
      <DrawerPopoverContent
        title={title}
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden p-0"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DatabaseMemberPicker database={database} />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function DatabaseMemberPicker({ database }: { database: NetworkDatabase }) {
  const inventory = useQuery(
    instanceInventoryQueryOptions(
      { kind: "database", id: database.id, relayId: database.relayId },
      "detail"
    )
  )
  const value = inventory.data
  const current =
    value?.kind === "database" && value.view === "detail" ? value.data : null
  const candidates = useDatabaseMemberCandidates(database)
  const items = React.useMemo(
    () =>
      [...candidates.values()].flatMap((candidate) =>
        candidate.canChange ? [candidate.item] : []
      ),
    [candidates]
  )
  const { pendingKey, toggle } = useDatabaseNetworkToggle(database)
  const selectedKeys = React.useMemo(
    () =>
      new Set(
        (current?.members ?? []).flatMap((member) =>
          member.saved ? [databaseMemberKey(member)] : []
        )
      ),
    [current?.members]
  )
  const toggleMember = React.useCallback(
    (item: InstancePickerItem) => {
      const candidate = candidates.get(item.key)
      if (!candidate) return
      toggle({
        connected: !selectedKeys.has(item.key),
        member: candidate.member,
      })
    },
    [candidates, selectedKeys, toggle]
  )

  // Background refreshes keep the open picker, its search, and its scroll.
  if (!inventory.isFetchedAfterMount)
    return (
      <p className="p-4 text-xs text-muted-foreground">Checking connections…</p>
    )
  if (
    inventory.isError ||
    !current ||
    value?.observation.inventory !== "available" ||
    value.observation.reachability !== "connected"
  )
    return (
      <p className="p-4 text-xs text-destructive">
        Connections are unavailable. Close and reopen to retry.
      </p>
    )

  return (
    <InstancePickerContent
      multiple
      ariaLabel="Game servers, Apps, and databases"
      emptyMessage={`No game servers, Apps, or databases on ${database.relayName} can be connected.`}
      items={items}
      pendingKey={pendingKey ?? undefined}
      selectedKeys={selectedKeys}
      onSelect={toggleMember}
    />
  )
}
