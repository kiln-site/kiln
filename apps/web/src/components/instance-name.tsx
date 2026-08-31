import * as React from "react"
import { and, eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import type { RelayObservedState } from "@workspace/contracts"
import { Database, RadioTower, Server } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { BrickIcon, type BrickIconPresentation } from "@/components/brick-icon"
import { managedDatabasesCollectionOptions } from "@/lib/collections/managed-databases"
import { relayInstancesCollectionOptions } from "@/lib/collections/relay-instances"
import { relayNodesCollectionOptions } from "@/lib/collections/relay-nodes"
import { relaysCollectionOptions } from "@/lib/collections/relays"

interface InstanceNameStatus {
  label: string
  tone: "danger" | "info" | "neutral" | "success" | "warning"
}

interface InstanceIdentity {
  id: string
  relayId: string
}

export type InstanceNameInstance =
  | (InstanceIdentity & {
      icon?: BrickIconPresentation
      kind: "server"
      observedState?: RelayObservedState
      relayStatus?: "connected" | "unreachable"
    })
  | (InstanceIdentity & {
      connected?: boolean
      enabled?: boolean
      kind: "relay"
      lastError?: string | null
      relayStatus?: "connected" | "unreachable"
      source?: "fleet" | "registry"
    })
  | (InstanceIdentity & {
      inventoryStatus?: "available" | "missing" | "unavailable"
      kind: "database"
      observedState?: RelayObservedState
    })

interface InstanceNameProps {
  className?: string
  iconClassName?: string
  instance: InstanceNameInstance
  meta?: React.ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: React.ReactNode
  nameClassName?: string
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

/**
 * The shell, live name, and live status own separate render boundaries so a
 * single field update cannot repaint the rest of the cell.
 */
export function InstanceName(props: InstanceNameProps) {
  return <MemoInstanceName {...props} />
}

const MemoInstanceName = React.memo(function MemoInstanceName({
  className,
  iconClassName,
  instance,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
}: InstanceNameProps) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground",
          iconClassName
        )}
      >
        <InstanceIcon instance={instance} />
        <LiveInstanceStatus instance={instance} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground",
            nameClassName
          )}
        >
          <LiveInstanceName fallback={name} instance={instance} />
          {nameAccessory}
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
      </span>
    </span>
  )
}, instanceNamePropsEqual)

function instanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps
): boolean {
  return (
    previous.className === next.className &&
    previous.iconClassName === next.iconClassName &&
    previous.meta === next.meta &&
    previous.metaClassName === next.metaClassName &&
    previous.nameAccessory === next.nameAccessory &&
    previous.nameClassName === next.nameClassName &&
    instancePresentationEqual(previous.instance, next.instance)
  )
}

function instancePresentationEqual(
  previous: InstanceNameInstance,
  next: InstanceNameInstance
): boolean {
  if (
    previous.id !== next.id ||
    previous.relayId !== next.relayId ||
    previous.kind !== next.kind
  ) {
    return false
  }
  if (previous.kind === "relay" && next.kind === "relay") {
    return previous.source === next.source
  }
  if (previous.kind !== "server" || next.kind !== "server") return true
  return (
    previous.icon?.id === next.icon?.id &&
    previous.icon?.color === next.icon?.color &&
    previous.icon?.iconSvg === next.icon?.iconSvg
  )
}

const LiveInstanceName = React.memo(function LiveInstanceName({
  fallback,
  instance,
}: {
  fallback: string
  instance: InstanceNameInstance
}) {
  if (instance.kind === "server") {
    return <LiveServerName fallback={fallback} instance={instance} />
  }
  if (instance.kind === "database") {
    return <LiveDatabaseName fallback={fallback} instance={instance} />
  }
  if (instance.source === "registry") {
    return <LiveRegistryRelayName fallback={fallback} instance={instance} />
  }
  return <LiveFleetRelayName fallback={fallback} instance={instance} />
})

function LiveServerName({
  fallback,
  instance,
}: {
  fallback: string
  instance: Extract<InstanceNameInstance, { kind: "server" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ server: relayInstancesCollectionOptions })
        .where(({ server }) =>
          and(eq(server.id, instance.id), eq(server.relayId, instance.relayId))
        )
        .select(({ server }) => ({ name: server.name })),
  })
  return <span className="truncate">{data?.[0]?.name ?? fallback}</span>
}

function LiveDatabaseName({
  fallback,
  instance,
}: {
  fallback: string
  instance: Extract<InstanceNameInstance, { kind: "database" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ database: managedDatabasesCollectionOptions })
        .where(({ database }) =>
          and(
            eq(database.id, instance.id),
            eq(database.relayId, instance.relayId)
          )
        )
        .select(({ database }) => ({ name: database.name })),
  })
  return <span className="truncate">{data?.[0]?.name ?? fallback}</span>
}

function LiveRegistryRelayName({
  fallback,
  instance,
}: {
  fallback: string
  instance: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, instance.id))
        .select(({ relay }) => ({ name: relay.name })),
  })
  return <span className="truncate">{data?.[0]?.name ?? fallback}</span>
}

function LiveFleetRelayName({
  fallback,
  instance,
}: {
  fallback: string
  instance: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relayNodesCollectionOptions })
        .where(({ relay }) => eq(relay.relayId, instance.relayId))
        .select(({ relay }) => ({ name: relay.relayName })),
  })
  return <span className="truncate">{data?.[0]?.name ?? fallback}</span>
}

const LiveInstanceStatus = React.memo(function LiveInstanceStatus({
  instance,
}: {
  instance: InstanceNameInstance
}) {
  if (instance.kind === "server") {
    return <LiveServerStatus fallback={instance} />
  }
  if (instance.kind === "database") {
    return <LiveDatabaseStatus fallback={instance} />
  }
  if (instance.source === "registry") {
    return <LiveRegistryRelayStatus fallback={instance} />
  }
  return <LiveFleetRelayStatus fallback={instance} />
})

function LiveServerStatus({
  fallback,
}: {
  fallback: Extract<InstanceNameInstance, { kind: "server" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ server: relayInstancesCollectionOptions })
        .where(({ server }) =>
          and(eq(server.id, fallback.id), eq(server.relayId, fallback.relayId))
        )
        .select(({ server }) => ({
          observedState: server.observedState,
          relayStatus: server.relayStatus,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceStatus
      status={instanceStatus({
        ...fallback,
        observedState: live?.observedState ?? fallback.observedState,
        relayStatus: live?.relayStatus ?? fallback.relayStatus,
      })}
    />
  )
}

function LiveDatabaseStatus({
  fallback,
}: {
  fallback: Extract<InstanceNameInstance, { kind: "database" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ database: managedDatabasesCollectionOptions })
        .where(({ database }) =>
          and(
            eq(database.id, fallback.id),
            eq(database.relayId, fallback.relayId)
          )
        )
        .select(({ database }) => ({
          inventoryStatus: database.inventoryStatus,
          observedState: database.observedState,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceStatus
      status={instanceStatus({
        ...fallback,
        inventoryStatus: live?.inventoryStatus ?? fallback.inventoryStatus,
        observedState: live?.observedState ?? fallback.observedState,
      })}
    />
  )
}

function LiveRegistryRelayStatus({
  fallback,
}: {
  fallback: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, fallback.id))
        .select(({ relay }) => ({
          enabled: relay.enabled,
          lastConnectedAt: relay.lastConnectedAt,
          lastError: relay.lastError,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceStatus
      status={instanceStatus({
        ...fallback,
        connected: live ? live.lastConnectedAt !== null : fallback.connected,
        enabled: live?.enabled ?? fallback.enabled,
        lastError: live ? live.lastError : fallback.lastError,
      })}
    />
  )
}

function LiveFleetRelayStatus({
  fallback,
}: {
  fallback: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relayNodesCollectionOptions })
        .where(({ relay }) => eq(relay.relayId, fallback.relayId))
        .select(({ relay }) => ({ relayStatus: relay.relayStatus })),
  })
  return (
    <InstanceStatus
      status={instanceStatus({
        ...fallback,
        relayStatus: data?.[0]?.relayStatus ?? fallback.relayStatus,
      })}
    />
  )
}

const InstanceStatus = React.memo(function InstanceStatus({
  status,
}: {
  status: InstanceNameStatus
}) {
  return (
    <>
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
          statusToneClassName[status.tone]
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Status: {status.label}</span>
    </>
  )
})

const InstanceIcon = React.memo(function InstanceIcon({
  instance,
}: {
  instance: InstanceNameInstance
}) {
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
})

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
