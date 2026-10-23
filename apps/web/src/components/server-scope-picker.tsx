import * as React from "react"
import { ArrowLeftRight, Layers } from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerGroup,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"

type ScopeKind = "app" | "database" | "relay" | "server"

/**
 * A scope target: one server, database, or Relay. Pages that can scope to an
 * app opt in through the kind parameter.
 */
export interface ServerPickerOption<
  K extends ScopeKind = Exclude<ScopeKind, "app">,
> {
  description?: string
  disabled?: boolean
  id: string
  kind?: K
  name: string
  relayId: string
  relayName: string
}

export const serverPickerOptionKey = (
  server: ServerPickerOption<ScopeKind>
) =>
  server.kind
    ? `${server.kind}:${server.relayId}:${server.id}`
    : `${server.relayId}:${server.id}`

const scopeKindPresentation: Record<
  ScopeKind,
  { Icon: typeof ServerKindIcon; label: string; one: string; other: string }
> = {
  app: { Icon: AppKindIcon, label: "All apps", one: "app", other: "apps" },
  database: {
    Icon: DatabaseKindIcon,
    label: "All databases",
    one: "database",
    other: "databases",
  },
  relay: {
    Icon: RelayKindIcon,
    label: "All Relays",
    one: "Relay",
    other: "Relays",
  },
  server: {
    Icon: ServerKindIcon,
    label: "All game servers",
    one: "game server",
    other: "game servers",
  },
}

interface ServerScopePickerProps<K extends ScopeKind> {
  allLabel?: string
  /** Offers "All instances", which selects `null`. */
  allowAll?: boolean
  ariaLabel?: string
  changeLabel?: string
  chooseLabel?: string
  emptyMessage?: string
  manageSettingsControl?: React.ReactNode
  manageSettingsTooltip?: string
  onSelect: (server: ServerPickerOption<K> | null) => void
  /** Enables whole-type scopes such as "All databases". */
  onSelectKind?: (kind: K) => void
  selectedKind?: K | null
  selectedRelayName?: string
  selectedServer: ServerPickerOption<K> | null
  servers: ReadonlyArray<ServerPickerOption<K>>
}

export const ServerScopePicker = React.memo(ServerScopePickerView) as <
  K extends ScopeKind = Exclude<ScopeKind, "app">,
>(
  props: ServerScopePickerProps<K>
) => React.ReactElement

function ServerScopePickerView<K extends ScopeKind>({
  allLabel = "All game servers",
  allowAll = true,
  ariaLabel = "Accessible game servers",
  changeLabel = "Change game server",
  chooseLabel = "Choose game server",
  emptyMessage = "No accessible game servers found.",
  manageSettingsControl,
  manageSettingsTooltip,
  onSelect,
  onSelectKind,
  selectedKind = null,
  selectedRelayName,
  selectedServer,
  servers,
}: ServerScopePickerProps<K>) {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const optionsByKey = React.useMemo(
    () =>
      new Map(servers.map((server) => [serverPickerOptionKey(server), server])),
    [servers]
  )
  const items = React.useMemo(
    () => servers.map(serverScopePickerItem),
    [servers]
  )
  const selectedKeys = React.useMemo(
    () =>
      new Set(selectedServer ? [serverPickerOptionKey(selectedServer)] : []),
    [selectedServer]
  )
  const selectedGroups = React.useMemo(
    (): ReadonlySet<InstancePickerGroup> =>
      selectedServer ? new Set() : new Set([selectedKind ?? "all"]),
    [selectedKind, selectedServer]
  )
  const selectServer = React.useCallback(
    (item: InstancePickerItem) => {
      const server = optionsByKey.get(item.key)
      if (!server) return
      onSelect(server)
      setPickerOpen(false)
    },
    [onSelect, optionsByKey]
  )
  const selectGroup = React.useCallback(
    (group: InstancePickerGroup) => {
      // Kind groups only show for kinds the options include.
      if (group === "all") onSelect(null)
      else onSelectKind?.(group as K)
      setPickerOpen(false)
    },
    [onSelect, onSelectKind]
  )
  const kindScope =
    selectedServer === null && selectedKind
      ? scopeKindPresentation[selectedKind]
      : null
  const kindCount = selectedKind
    ? servers.filter((server) => (server.kind ?? "server") === selectedKind)
        .length
    : 0
  const selectionMetadata = selectedServer
    ? selectedServer.id
    : kindScope
      ? `${kindCount} accessible ${kindCount === 1 ? kindScope.one : kindScope.other}, including new ones`
      : `${servers.length} accessible ${servers.length === 1 ? "instance" : "instances"}`
  const scopeKind = selectedServer?.kind ?? selectedKind
  const ScopeIcon = scopeKind ? scopeKindPresentation[scopeKind].Icon : Layers

  return (
    <div className="mb-3">
      <DrawerPopover open={pickerOpen} onOpenChange={setPickerOpen}>
        <WorkspaceSummaryCard
          action={
            <div className="flex shrink-0 items-center gap-2">
              {manageSettingsControl ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{manageSettingsControl}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {manageSettingsTooltip ?? "Settings"}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <DrawerPopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  <ArrowLeftRight />
                  {selectedServer || kindScope ? changeLabel : chooseLabel}
                </Button>
              </DrawerPopoverTrigger>
            </div>
          }
          icon={<ScopeIcon className="size-5" />}
          title={selectedServer?.name ?? kindScope?.label ?? allLabel}
          titleAccessory={
            <Badge variant="outline" className="type-meta font-mono">
              {selectedServer?.kind === "relay"
                ? "Relay"
                : (selectedServer?.relayName ??
                  selectedRelayName ??
                  "All Relays")}
            </Badge>
          }
        >
          <p className="type-meta mt-1 truncate font-mono text-muted-foreground">
            {selectionMetadata}
          </p>
        </WorkspaceSummaryCard>
        <DrawerPopoverContent
          title={ariaLabel}
          align="end"
          className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <InstancePickerContent
            ariaLabel={ariaLabel}
            emptyMessage={emptyMessage}
            includeAllGroup={allowAll}
            includeKindGroups={onSelectKind !== undefined}
            items={items}
            selectedGroups={selectedGroups}
            selectedKeys={selectedKeys}
            onSelect={selectServer}
            onSelectGroup={allowAll || onSelectKind ? selectGroup : undefined}
          />
        </DrawerPopoverContent>
      </DrawerPopover>
    </div>
  )
}

function serverScopePickerItem(
  server: ServerPickerOption<ScopeKind>
): InstancePickerItem {
  const kind = server.kind ?? "server"
  return {
    disabled: server.disabled,
    identity:
      kind === "relay"
        ? {
            id: server.relayId,
            kind,
            relayId: server.relayId,
            source: "fleet",
          }
        : { id: server.id, kind, relayId: server.relayId },
    key: serverPickerOptionKey(server),
    meta:
      kind === "relay"
        ? server.relayId.slice(0, 8)
        : `${server.relayName} · ${server.id.slice(0, 8)}`,
    name: server.name,
    searchText: `${server.id} ${server.relayName} ${server.relayId}`,
  }
}
