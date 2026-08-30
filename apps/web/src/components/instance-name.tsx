import type { ReactNode } from "react"
import type { RelayObservedState } from "@workspace/contracts"
import { Database, RadioTower, Server } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { BrickIcon, type BrickIconPresentation } from "@/components/brick-icon"

interface InstanceNameStatus {
  label: string
  tone: "danger" | "info" | "neutral" | "success" | "warning"
}

export type InstanceNameInstance =
  | {
      icon?: BrickIconPresentation
      kind: "server"
      observedState?: RelayObservedState
      relayStatus?: "connected" | "unreachable"
    }
  | {
      connected?: boolean
      enabled?: boolean
      kind: "relay"
      lastError?: string | null
      relayStatus?: "connected" | "unreachable"
    }
  | {
      inventoryStatus?: "available" | "missing" | "unavailable"
      kind: "database"
      observedState?: RelayObservedState
    }

function observedStatus(state: RelayObservedState): InstanceNameStatus {
  if (state === "running") {
    return { label: "Running", tone: "success" }
  }
  if (state === "failed") {
    return { label: "Failed", tone: "danger" }
  }
  if (state === "starting" || state === "provisioning") {
    return {
      label: state === "starting" ? "Starting" : "Provisioning",
      tone: "warning",
    }
  }
  if (state === "stopping") {
    return { label: "Stopping", tone: "warning" }
  }
  return { label: "Stopped", tone: "neutral" }
}

export function InstanceName({
  className,
  iconClassName,
  instance,
  meta,
  metaClassName,
  name,
  nameClassName,
}: {
  className?: string
  iconClassName?: string
  instance: InstanceNameInstance
  meta?: ReactNode
  metaClassName?: string
  name: ReactNode
  nameClassName?: string
}) {
  const status = instanceStatus(instance)
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground",
          iconClassName
        )}
      >
        <InstanceIcon instance={instance} />
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
            statusToneClassName[status.tone]
          )}
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs font-semibold text-foreground",
            nameClassName
          )}
        >
          {name}
        </span>
        {meta ? (
          <span
            className={cn(
              "type-meta block truncate text-muted-foreground",
              metaClassName
            )}
          >
            {meta}
          </span>
        ) : null}
        <span className="sr-only">Status: {status.label}</span>
      </span>
    </span>
  )
}

function InstanceIcon({ instance }: { instance: InstanceNameInstance }) {
  if (instance.kind === "server" && instance.icon) {
    return (
      <BrickIcon
        id={instance.icon.id}
        color={instance.icon.color}
        iconSvg={instance.icon.iconSvg}
        className="size-6"
        aria-hidden="true"
      />
    )
  }

  const Icon =
    instance.kind === "database"
      ? Database
      : instance.kind === "relay"
        ? RadioTower
        : Server
  return <Icon className="size-4" aria-hidden="true" />
}

function instanceStatus(instance: InstanceNameInstance): InstanceNameStatus {
  if (instance.kind === "server") {
    if (instance.relayStatus === "unreachable") {
      return { label: "Relay unavailable", tone: "danger" }
    }
    return instance.observedState
      ? observedStatus(instance.observedState)
      : { label: "Status unavailable", tone: "neutral" }
  }

  if (instance.kind === "relay") {
    if (instance.enabled === false) {
      return { label: "Paused", tone: "info" }
    }
    if (instance.lastError || instance.relayStatus === "unreachable") {
      return { label: "Unreachable", tone: "danger" }
    }
    if (instance.connected || instance.relayStatus === "connected") {
      return { label: "Online", tone: "success" }
    }
    return { label: "Offline", tone: "neutral" }
  }

  if (instance.inventoryStatus === "missing") {
    return { label: "Missing", tone: "danger" }
  }
  if (instance.inventoryStatus === "unavailable") {
    return { label: "Unavailable", tone: "warning" }
  }
  return instance.observedState
    ? observedStatus(instance.observedState)
    : { label: "Status unavailable", tone: "neutral" }
}

const statusToneClassName: Record<InstanceNameStatus["tone"], string> = {
  danger: "bg-destructive",
  info: "bg-sky-400",
  neutral: "bg-muted-foreground/45",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
}
