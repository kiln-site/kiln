import * as React from "react"
import {
  ArrowLeftRight,
  Database,
  Network,
  Server,
  SlidersHorizontal,
} from "lucide-react"

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
  ServerPickerList,
  serverPickerOptionKey,
  type ServerPickerOption,
} from "@/components/server-picker-list"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"

export const ServerScopePicker = React.memo(function ServerScopePicker({
  allDescription = "Every accessible instance",
  allLabel = "All servers",
  ariaLabel = "Accessible servers",
  canManageSettings = false,
  changeLabel = "Change server",
  chooseLabel = "Choose server",
  emptyMessage = "No accessible servers found.",
  onManageSettings,
  onSelect,
  selectedRelayName,
  selectedServer,
  servers,
}: {
  allDescription?: string
  allLabel?: string
  ariaLabel?: string
  canManageSettings?: boolean
  changeLabel?: string
  chooseLabel?: string
  emptyMessage?: string
  onManageSettings?: () => void
  onSelect: (server: ServerPickerOption | null) => void
  selectedRelayName?: string
  selectedServer: ServerPickerOption | null
  servers: ReadonlyArray<ServerPickerOption>
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const selectedKeys = React.useMemo(
    () =>
      new Set(selectedServer ? [serverPickerOptionKey(selectedServer)] : []),
    [selectedServer]
  )
  const selectServer = React.useCallback(
    (server: ServerPickerOption) => {
      onSelect(server)
      setPickerOpen(false)
    },
    [onSelect]
  )
  const selectionMetadata = selectedServer
    ? selectedServer.id
    : `${servers.length} accessible ${servers.length === 1 ? "instance" : "instances"}`
  const ScopeIcon =
    selectedServer?.kind === "database"
      ? Database
      : selectedServer?.kind === "relay"
        ? Network
        : Server

  return (
    <div className="mb-3">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <WorkspaceSummaryCard
          action={
            <div className="flex shrink-0 items-center gap-2">
              {onManageSettings ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        aria-label="Manage selected backup settings"
                        disabled={!canManageSettings}
                        size="icon-sm"
                        type="button"
                        variant="outline"
                        onClick={onManageSettings}
                      >
                        <SlidersHorizontal />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {canManageSettings
                      ? "Backup settings"
                      : "Choose an instance to manage its backup settings"}
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
                  {selectedServer ? changeLabel : chooseLabel}
                </Button>
              </PopoverTrigger>
            </div>
          }
          icon={<ScopeIcon className="size-5" />}
          title={selectedServer?.name ?? allLabel}
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
          className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
        >
          <ServerPickerList
            allOption={{
              description: allDescription,
              label: allLabel,
              selected: selectedServer === null,
              onSelect: () => {
                onSelect(null)
                setPickerOpen(false)
              },
            }}
            ariaLabel={ariaLabel}
            emptyMessage={emptyMessage}
            selectedKeys={selectedKeys}
            servers={servers}
            onSelect={selectServer}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
})
