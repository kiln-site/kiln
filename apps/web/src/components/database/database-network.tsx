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

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
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
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { updateManagedDatabaseNetwork } from "@/server/databases"

type NetworkDatabase = Pick<
  ManagedDatabase,
  "id" | "name" | "relayId" | "relayName"
>

// Servers on the database's Relay that the user may attach to its network.
export function useConnectableDatabaseServers(
  database: Pick<NetworkDatabase, "relayId">
): Array<InstancePickerItem> {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { data: instances } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: (snapshot) => snapshot.instances,
  })
  return React.useMemo(
    () =>
      (instances ?? [])
        .flatMap((instance) =>
          instance.relayId === database.relayId &&
          canAccessInstancePermission(
            capabilities,
            instance,
            "instance.network.write"
          )
            ? [
                {
                  identity: {
                    brickId: instance.brickId,
                    brickSource: instance.brickSource,
                    id: instance.id,
                    implementation: instance.implementation,
                    kind: "server",
                    observedState: instance.observedState,
                    relayId: instance.relayId,
                  },
                  key: `${instance.relayId}:${instance.id}`,
                  meta: `${instance.implementation} ${instance.version} · ${instance.shortId}`,
                  name: instance.name,
                  searchText: `${instance.id} ${instance.relayName}`,
                } satisfies InstancePickerItem,
              ]
            : []
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [capabilities, database.relayId, instances]
  )
}

export function useDatabaseNetworkToggle(
  database: Pick<NetworkDatabase, "id" | "relayId">
) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: (input: { connected: boolean; instanceId: string }) =>
      updateManagedDatabaseNetwork({
        data: {
          ...input,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: instanceInventoryScope({
          kind: "database",
          relayId: database.relayId,
          id: database.id,
        }),
      })
    },
    onError: (error) =>
      showDatabaseOperationError("Network update failed", error),
  })
  return {
    pendingInstanceId: update.isPending ? update.variables.instanceId : null,
    toggle: update.mutate,
  }
}

export const DatabaseNetworkPicker = React.memo(function DatabaseNetworkPicker({
  database,
  variant = "icon",
}: {
  database: NetworkDatabase
  variant?: "button" | "icon"
}) {
  const [open, setOpen] = React.useState(false)

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
            Connect servers
          </Button>
        </DrawerPopoverTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <DrawerPopoverTrigger asChild>
              <Button
                aria-label={`Connect game servers to ${database.name}`}
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
          <TooltipContent side="bottom">Connect game servers</TooltipContent>
        </Tooltip>
      )}
      <DrawerPopoverContent
        title={`Connect game servers to ${database.name}`}
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <DatabaseServerPicker database={database} />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function DatabaseServerPicker({ database }: { database: NetworkDatabase }) {
  const inventory = useQuery(
    instanceInventoryQueryOptions(
      { kind: "database", id: database.id, relayId: database.relayId },
      "detail"
    )
  )
  const value = inventory.data
  const current =
    value?.kind === "database" && value.view === "detail" ? value.data : null
  const servers = useConnectableDatabaseServers(database)
  const { pendingInstanceId, toggle } = useDatabaseNetworkToggle(database)
  const selectedKeys = React.useMemo(
    () =>
      new Set(
        (current?.connectedInstanceIds ?? []).map(
          (instanceId) => `${database.relayId}:${instanceId}`
        )
      ),
    [current?.connectedInstanceIds, database.relayId]
  )
  const toggleServer = React.useCallback(
    (item: InstancePickerItem) =>
      toggle({
        connected: !selectedKeys.has(item.key),
        instanceId: item.identity.id,
      }),
    [selectedKeys, toggle]
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
      ariaLabel="Game Servers"
      emptyMessage={`No connectable game servers are hosted on ${database.relayName}.`}
      items={servers}
      pendingKey={
        pendingInstanceId
          ? `${database.relayId}:${pendingInstanceId}`
          : undefined
      }
      selectedKeys={selectedKeys}
      onSelect={toggleServer}
    />
  )
}
