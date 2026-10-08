import * as React from "react"
import type { RelayObservedState } from "@workspace/contracts"
import {
  CircleStop,
  EllipsisVertical,
  LoaderCircle,
  OctagonX,
  Play,
  RotateCw,
} from "lucide-react"

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
  isPowerControlLocked,
  type ServerAction,
} from "@/lib/instance-power-state"

export function WorkspacePowerControls({
  action,
  killWarning,
  noun,
  powerPermissions,
  target,
  onAction,
  relayConnected,
}: {
  action: ServerAction | null
  // Shown before a kill; kill is offered only when this is set.
  killWarning?: string
  // Lowercase, for example "server".
  noun: string
  powerPermissions: Record<ServerAction, boolean>
  target: {
    name: string
    observedState: RelayObservedState
    provisioning?: { phase: string } | null
  }
  onAction: (action: ServerAction) => Promise<void>
  relayConnected: boolean
}) {
  const [serverActionsOpen, setServerActionsOpen] = React.useState(false)
  const [confirmKill, setConfirmKill] = React.useState(false)
  if (!Object.values(powerPermissions).some(Boolean)) return null
  const capitalizedNoun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`

  const isRunning = target.observedState === "running"
  const isStarting = target.observedState === "starting"
  const isStopping = target.observedState === "stopping"
  const isProvisioning =
    Boolean(target.provisioning) || isPowerControlLocked(target.observedState)
  const provisioningFailed = target.provisioning?.phase === "failed"
  const powerIsOn = isRunning || isStarting
  const powerIsTransitioning =
    action === "start" ||
    action === "stop" ||
    action === "restart" ||
    isStopping ||
    isProvisioning
  const controlsUnavailable =
    !relayConnected || action !== null || isProvisioning
  const startUnavailable =
    !powerPermissions.start || controlsUnavailable || powerIsOn || isStopping
  const stopUnavailable =
    !powerPermissions.stop || controlsUnavailable || !powerIsOn || isStopping

  function runAction(nextAction: ServerAction) {
    if (!powerPermissions[nextAction]) return
    setServerActionsOpen(false)
    setConfirmKill(false)
    void onAction(nextAction)
  }

  return (
    <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 xl:col-start-3">
      <Button
        variant="outline"
        size="sm"
        className={
          powerIsOn
            ? "hidden h-9 w-[6.5rem] justify-center gap-1.5 !border-red-500/65 !bg-red-600 px-3 text-xs !text-white shadow-none hover:!border-red-400 hover:!bg-red-500 disabled:!border-red-500/35 disabled:!bg-red-600/45 disabled:!text-white/70 md:inline-flex"
            : "hidden h-9 w-[6.5rem] justify-center gap-1.5 !border-blue-500/65 !bg-blue-600 px-3 text-xs !text-white shadow-none hover:!border-blue-400 hover:!bg-blue-500 md:inline-flex"
        }
        disabled={powerIsOn ? stopUnavailable : startUnavailable}
        onClick={() => runAction(powerIsOn ? "stop" : "start")}
      >
        {powerIsTransitioning ? (
          <LoaderCircle className="animate-spin" />
        ) : powerIsOn ? (
          <CircleStop />
        ) : (
          <Play />
        )}
        {action === "start"
          ? "Starting"
          : action === "stop" || action === "restart" || isStopping
            ? "Stopping"
            : isProvisioning
              ? provisioningFailed
                ? "Failed"
                : "Provisioning"
              : powerIsOn
                ? "Stop"
                : "Start"}
      </Button>
      <Popover
        open={serverActionsOpen}
        onOpenChange={(open) => {
          setServerActionsOpen(open)
          if (!open) setConfirmKill(false)
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon-lg"
                className="h-9 w-8 bg-card shadow-none"
                aria-label={`${capitalizedNoun} actions`}
                disabled={controlsUnavailable}
              >
                <EllipsisVertical />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Power Options
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          sideOffset={7}
          className="w-[min(17rem,calc(100vw-1.5rem))] p-0"
        >
          {confirmKill ? (
            <>
              <div className="border-b px-3 py-2.5">
                <p className="text-xs font-semibold text-foreground">
                  Kill {target.name}?
                </p>
                <p className="type-support mt-1 text-muted-foreground">
                  {killWarning}
                </p>
              </div>
              <div className="flex justify-end gap-1.5 p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmKill(false)}
                >
                  Back
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="!border-red-500/65 !bg-red-600 !text-white hover:!border-red-400 hover:!bg-red-500"
                  disabled={!powerPermissions.kill || controlsUnavailable}
                  onClick={() => runAction("kill")}
                >
                  <OctagonX />
                  Kill now
                </Button>
              </div>
            </>
          ) : (
            <div className="p-1">
              <p className="type-technical-label border-b px-2 py-2 text-muted-foreground">
                {capitalizedNoun} actions
              </p>
              <PowerActionButton
                description={`Power on the ${noun}`}
                disabled={startUnavailable}
                icon={<Play className="size-3.5" />}
                label="Start"
                tone="start"
                onClick={() => runAction("start")}
              />
              <PowerActionButton
                description="Gracefully shut down"
                disabled={stopUnavailable}
                icon={<CircleStop className="size-3.5" />}
                label="Stop"
                tone="stop"
                onClick={() => runAction("stop")}
              />
              <PowerActionButton
                description="Gracefully stop and start"
                disabled={
                  !powerPermissions.restart || controlsUnavailable || !isRunning
                }
                icon={<RotateCw className="size-3.5" />}
                label="Restart"
                onClick={() => runAction("restart")}
              />
              {killWarning ? (
                <PowerActionButton
                  description="Terminate immediately"
                  disabled={
                    !powerPermissions.kill ||
                    controlsUnavailable ||
                    !powerIsOn ||
                    isStopping
                  }
                  icon={<OctagonX className="size-3.5" />}
                  label="Kill"
                  tone="kill"
                  onClick={() => setConfirmKill(true)}
                />
              ) : null}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function PowerActionButton({
  description,
  disabled,
  icon,
  label,
  onClick,
  tone = "default",
}: {
  description: string
  disabled: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
  tone?: "default" | "start" | "stop" | "kill"
}) {
  const toneClassName = {
    default: "text-foreground hover:bg-popover-accent/80",
    start: disabled
      ? "text-muted-foreground/35"
      : "text-blue-300 hover:bg-blue-500/10",
    stop: disabled
      ? "text-muted-foreground/35"
      : "text-red-400 hover:bg-red-500/10",
    kill: "text-red-400 hover:bg-red-500/10",
  }[tone]
  const iconClassName = {
    default: "border-border bg-card text-muted-foreground",
    start: disabled
      ? "border-border/55 bg-muted/15"
      : "border-blue-500/25 bg-blue-500/5",
    stop: disabled
      ? "border-border/55 bg-muted/15"
      : "border-red-500/25 bg-red-500/5",
    kill: "border-red-500/25 bg-red-500/5",
  }[tone]
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2.5 px-2 py-2 text-left text-xs transition-colors focus-visible:bg-popover-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-35 ${toneClassName}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className={`grid size-7 place-items-center border ${iconClassName}`}
      >
        {icon}
      </span>
      <span>
        <span className="block font-medium">{label}</span>
        <span className="type-meta block text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}
