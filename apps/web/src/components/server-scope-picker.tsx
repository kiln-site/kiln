import * as React from "react"
import { ArrowLeftRight, Database, Network, Server } from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  InstancePickerContent,
  type InstancePickerGroup,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  serverPickerOptionKey,
  type ServerPickerOption,
} from "@/components/server-picker-list"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"

type ScopeKind = NonNullable<ServerPickerOption["kind"]>

const scopeKindPresentation: Record<
  ScopeKind,
  { Icon: typeof Server; label: string; one: string; other: string }
> = {
  database: {
    Icon: Database,
    label: "All databases",
    one: "database",
    other: "databases",
  },
  relay: { Icon: Network, label: "All Relays", one: "Relay", other: "Relays" },
  server: {
    Icon: Server,
    label: "All servers",
    one: "server",
    other: "servers",
  },
}

export const ServerScopePicker = React.memo(function ServerScopePicker({
  allLabel = "All servers",
  allowAll = true,
  ariaLabel = "Accessible servers",
  changeLabel = "Change server",
  chooseLabel = "Choose server",
  emptyMessage = "No accessible servers found.",
  manageSettingsControl,
  manageSettingsTooltip,
  onSelect,
  onSelectKind,
  selectedKind = null,
  selectedRelayName,
  selectedServer,
  servers,
}: {
  allLabel?: string
  /** Offers "All instances", which selects `null`. */
  allowAll?: boolean
  ariaLabel?: string
  changeLabel?: string
  chooseLabel?: string
  emptyMessage?: string
  manageSettingsControl?: React.ReactNode
  manageSettingsTooltip?: string
  onSelect: (server: ServerPickerOption | null) => void
  /** Enables whole-type scopes such as "All databases". */
  onSelectKind?: (kind: ScopeKind) => void
  selectedKind?: ScopeKind | null
  selectedRelayName?: string
  selectedServer: ServerPickerOption | null
  servers: ReadonlyArray<ServerPickerOption>
}) {
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
      if (group === "all") onSelect(null)
      else onSelectKind?.(group)
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
  const ScopeIcon =
    (selectedServer?.kind ?? selectedKind) === "database"
      ? Database
      : (selectedServer?.kind ?? selectedKind) === "relay"
        ? Network
        : Server

  return (
    <div className="mb-3">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
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
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  <ArrowLeftRight />
                  {selectedServer || kindScope ? changeLabel : chooseLabel}
                </Button>
              </PopoverTrigger>
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
        <PopoverContent
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
        </PopoverContent>
      </Popover>
    </div>
  )
})

function serverScopePickerItem(server: ServerPickerOption): InstancePickerItem {
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
