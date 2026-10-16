import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useRouteContext } from "@tanstack/react-router"
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
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  messageFrom,
  RelayPauseDialog,
  useRelayPauseToggle,
} from "@/components/relay/relay-actions"
import { relayHostAccessQueryOptions } from "@/components/relay/relay-host-access"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { PowerActionButton } from "@/components/workspace-power-controls"
import { isDevelopmentBypassIdentity } from "@/lib/development-bypass"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import { restartRelay, restartRelayHost } from "@/server/relay-host"

type RelayRestartTarget = "relay" | "host"

const restartCopy = {
  host: {
    action: "Restart host",
    description:
      "All game servers, apps, and databases on this host will restart.",
    title: (name: string) => `Restart ${name}’s host?`,
  },
  relay: {
    action: "Restart Relay",
    description:
      "Game servers keep running. The Relay reconnects in a few seconds.",
    title: (name: string) => `Restart ${name}?`,
  },
} satisfies Record<RelayRestartTarget, unknown>

// The Relay workspace's header actions: Restart Relay, and a menu that also
// pauses or resumes the Relay and restarts its host.
export const RelayPowerControls = React.memo(function RelayPowerControls({
  permissions,
  relay,
}: {
  permissions: { pause: boolean; restartHost: boolean; restartRelay: boolean }
  relay: RelayDirectoryEntry
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirming, setConfirming] = React.useState<
    RelayRestartTarget | "pause" | null
  >(null)
  const pause = useRelayPauseToggle(relay)
  const { connected, updating } = useRelayLiveStatus(relay)
  // Asked when the menu opens: with host access off, the Relay refuses.
  const { data: hostAccess } = useQuery({
    ...relayHostAccessQueryOptions(relay.id),
    enabled: menuOpen && permissions.restartHost && connected,
    select: (access) => access.terminal,
  })
  if (
    !permissions.pause &&
    !permissions.restartRelay &&
    !permissions.restartHost
  )
    return null

  // Restarting mid-update could break the update.
  const restartUnavailable = !relay.enabled || !connected || updating

  // Pausing asks first; resuming doesn't.
  function togglePause() {
    setMenuOpen(false)
    if (relay.enabled) setConfirming("pause")
    else void pause.toggle()
  }

  function confirmRestart(target: RelayRestartTarget) {
    setMenuOpen(false)
    setConfirming(target)
  }

  return (
    <div className="flex shrink-0 items-center justify-end gap-1.5">
      {permissions.restartRelay ? (
        <Button
          variant="outline"
          size="sm"
          className="hidden h-9 min-w-[6.5rem] justify-center gap-1.5 !border-red-500/65 !bg-red-600 px-3 text-xs !text-white shadow-none hover:!border-red-400 hover:!bg-red-500 disabled:!border-red-500/35 disabled:!bg-red-600/45 disabled:!text-white/70 md:inline-flex"
          disabled={restartUnavailable}
          onClick={() => setConfirming("relay")}
        >
          <RotateCw />
          Restart Relay
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
                description="Game servers keep running"
                disabled={restartUnavailable}
                icon={<RotateCw className="size-3.5" />}
                label="Restart Relay"
                onClick={() => confirmRestart("relay")}
              />
            ) : null}
            {permissions.restartHost ? (
              <PowerActionButton
                description={
                  hostAccess === false
                    ? "Host access is off on this Relay"
                    : "Reboots everything on this machine"
                }
                disabled={restartUnavailable || hostAccess === false}
                icon={<Power className="size-3.5" />}
                label="Restart host"
                tone="kill"
                onClick={() => confirmRestart("host")}
              />
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {confirming === "pause" ? (
        <RelayPauseDialog relay={relay} onClose={() => setConfirming(null)} />
      ) : confirming ? (
        <RelayRestartDialog
          relay={relay}
          target={confirming}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  )
})

// Mounted only while open, so each opening starts with an empty password.
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
  const passwordRequired = useRouteContext({
    from: "/_app",
    select: ({ user }) =>
      target === "host" && !isDevelopmentBypassIdentity(user),
  })
  const [password, setPassword] = React.useState("")
  const restart = useMutation({
    mutationFn: () =>
      target === "relay"
        ? restartRelay({ data: { relayId: relay.id } })
        : restartRelayHost({ data: { password, relayId: relay.id } }),
    onSuccess: () => {
      onClose()
      showToast({
        type: "info",
        message:
          target === "relay"
            ? `Restarting ${relay.name}`
            : `Restarting ${relay.name}’s host`,
        duration: 4_000,
      })
    },
  })
  const pending = restart.isPending
  const error = restart.error
    ? messageFrom(
        restart.error,
        target === "relay"
          ? "Could not restart the Relay."
          : "Could not restart the host."
      )
    : null

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || (passwordRequired && !password)) return
    restart.mutate()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{copy.title(relay.name)}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          {passwordRequired ? (
            <div className="grid gap-1.5">
              <label
                htmlFor="restart-host-password"
                className="type-technical-label text-muted-foreground"
              >
                Account password
              </label>
              <Input
                id="restart-host-password"
                aria-label="Account password"
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value)
                  restart.reset()
                }}
                autoComplete="current-password"
                autoFocus
                placeholder="Enter your account password"
                className="bg-background"
                disabled={pending}
                required
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="type-meta text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="ghost"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || (passwordRequired && !password)}
              type="submit"
              variant={target === "host" ? "destructive" : "default"}
            >
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : target === "relay" ? (
                <RotateCw />
              ) : (
                <Power />
              )}
              {copy.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
