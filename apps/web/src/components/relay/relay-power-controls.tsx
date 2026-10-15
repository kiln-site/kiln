import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  EllipsisVertical,
  LoaderCircle,
  Pause,
  Play,
  Power,
  RotateCw,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  showRelayError,
  useRelayPauseToggle,
} from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { PowerActionButton } from "@/components/workspace-power-controls"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import { restartRelay, restartRelayHost } from "@/server/relay-host"

type RelayRestartTarget = "relay" | "host"

const restartCopy = {
  host: {
    action: "Restart host",
    failure: "Could not restart the host",
    pending: "The host is rebooting. The Relay reconnects once it is back up.",
    title: (name: string) => `Restart ${name}’s host?`,
    warning:
      "The machine the Relay runs on reboots. Every game server, app, and database on it stops, disconnecting players, and starts again once the host is back up. The Relay is offline until then.",
  },
  relay: {
    action: "Restart Relay",
    failure: "Could not restart the Relay",
    pending:
      "Hearth reconnects once the Relay is back, usually within seconds.",
    title: (name: string) => `Restart ${name}?`,
    warning:
      "The Relay restarts and reconnects to Hearth within a few seconds. Game servers, apps, and databases keep running, but open consoles, terminals, and transfers are interrupted.",
  },
} satisfies Record<RelayRestartTarget, unknown>

// The Relay workspace's header actions: Pause or Resume, and a menu that also
// restarts the Relay or its host.
export const RelayPowerControls = React.memo(function RelayPowerControls({
  permissions,
  relay,
}: {
  permissions: { pause: boolean; restartHost: boolean; restartRelay: boolean }
  relay: RelayDirectoryEntry
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirming, setConfirming] = React.useState<RelayRestartTarget | null>(
    null
  )
  const pause = useRelayPauseToggle(relay)
  const { connected } = useRelayLiveStatus(relay)
  if (
    !permissions.pause &&
    !permissions.restartRelay &&
    !permissions.restartHost
  )
    return null

  const restartUnavailable = !relay.enabled || !connected

  function togglePause() {
    setMenuOpen(false)
    pause.toggle()
  }

  function confirmRestart(target: RelayRestartTarget) {
    setMenuOpen(false)
    setConfirming(target)
  }

  return (
    <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 xl:col-start-3">
      {permissions.pause ? (
        <Button
          variant="outline"
          size="sm"
          className={
            relay.enabled
              ? "hidden h-9 w-[6.5rem] justify-center gap-1.5 !border-red-500/65 !bg-red-600 px-3 text-xs !text-white shadow-none hover:!border-red-400 hover:!bg-red-500 disabled:!border-red-500/35 disabled:!bg-red-600/45 disabled:!text-white/70 md:inline-flex"
              : "hidden h-9 w-[6.5rem] justify-center gap-1.5 !border-blue-500/65 !bg-blue-600 px-3 text-xs !text-white shadow-none hover:!border-blue-400 hover:!bg-blue-500 disabled:!border-blue-500/35 disabled:!bg-blue-600/45 disabled:!text-white/70 md:inline-flex"
          }
          disabled={pause.pending}
          onClick={pause.toggle}
        >
          {pause.pending ? (
            <LoaderCircle className="animate-spin" />
          ) : relay.enabled ? (
            <Pause />
          ) : (
            <Play />
          )}
          {pause.pending
            ? relay.enabled
              ? "Pausing"
              : "Resuming"
            : relay.enabled
              ? "Pause"
              : "Resume"}
        </Button>
      ) : null}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon-lg"
                className="h-9 w-8 bg-card shadow-none"
                aria-label="Relay actions"
              >
                <EllipsisVertical />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Relay actions
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={7}
          className="w-[min(17rem,calc(100vw-1.5rem))] p-0"
        >
          <div className="p-1">
            <p className="type-technical-label border-b px-2 py-2 text-muted-foreground">
              Relay actions
            </p>
            {permissions.pause ? (
              <PowerActionButton
                description={
                  relay.enabled
                    ? "Stop requesting data from this Relay"
                    : "Reconnect Hearth to this Relay"
                }
                disabled={pause.pending}
                icon={
                  relay.enabled ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5" />
                  )
                }
                label={relay.enabled ? "Pause" : "Resume"}
                tone={relay.enabled ? "default" : "start"}
                onClick={togglePause}
              />
            ) : null}
            {permissions.restartRelay ? (
              <PowerActionButton
                description="Servers keep running"
                disabled={restartUnavailable}
                icon={<RotateCw className="size-3.5" />}
                label="Restart Relay"
                onClick={() => confirmRestart("relay")}
              />
            ) : null}
            {permissions.restartHost ? (
              <PowerActionButton
                description="Reboots everything on this machine"
                disabled={restartUnavailable}
                icon={<Power className="size-3.5" />}
                label="Restart host"
                tone="kill"
                onClick={() => confirmRestart("host")}
              />
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {confirming ? (
        <RelayRestartDialog
          relay={relay}
          target={confirming}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  )
})

// Mounted only while open.
function RelayRestartDialog({
  relay,
  target,
  onClose,
}: {
  relay: RelayDirectoryEntry
  target: RelayRestartTarget
  onClose: () => void
}) {
  const copy = restartCopy[target]
  const restart = useMutation({
    mutationFn: () =>
      (target === "relay" ? restartRelay : restartRelayHost)({
        data: { relayId: relay.id },
      }),
    onSuccess: () => {
      onClose()
      showToast({
        type: "info",
        message:
          target === "relay"
            ? `Restarting ${relay.name}`
            : `Restarting ${relay.name}’s host`,
        description: copy.pending,
        duration: 6_000,
      })
    },
    onError: (cause) => showRelayError(cause, copy.failure),
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !restart.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title(relay.name)}</DialogTitle>
          <DialogDescription>{copy.warning}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            disabled={restart.isPending}
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={restart.isPending}
            type="button"
            variant={target === "host" ? "destructive" : "default"}
            onClick={() => restart.mutate()}
          >
            {restart.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : target === "relay" ? (
              <RotateCw />
            ) : (
              <Power />
            )}
            {copy.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
