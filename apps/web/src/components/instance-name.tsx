import type { ReactNode } from "react"
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
  meta?: ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: ReactNode
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

export function InstanceName(props: InstanceNameProps) {
  if (props.instance.kind === "server") {
    return <LiveServerInstanceName {...props} instance={props.instance} />
  }
  if (props.instance.kind === "database") {
    return <LiveDatabaseInstanceName {...props} instance={props.instance} />
  }
  if (props.instance.source === "registry") {
    return <LiveRegistryRelayName {...props} instance={props.instance} />
  }
  return <LiveFleetRelayName {...props} instance={props.instance} />
}

function LiveServerInstanceName({
  instance,
  ...props
}: InstanceNameProps & {
  instance: Extract<InstanceNameInstance, { kind: "server" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ server: relayInstancesCollectionOptions })
        .where(({ server }) =>
          and(eq(server.id, instance.id), eq(server.relayId, instance.relayId))
        )
        .select(({ server }) => ({
          name: server.name,
          observedState: server.observedState,
          relayStatus: server.relayStatus,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      instance={{
        ...instance,
        observedState: live?.observedState ?? instance.observedState,
        relayStatus: live?.relayStatus ?? instance.relayStatus,
      }}
      name={live?.name ?? props.name}
    />
  )
}

function LiveDatabaseInstanceName({
  instance,
  ...props
}: InstanceNameProps & {
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
        .select(({ database }) => ({
          inventoryStatus: database.inventoryStatus,
          name: database.name,
          observedState: database.observedState,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      instance={{
        ...instance,
        inventoryStatus: live?.inventoryStatus ?? instance.inventoryStatus,
        observedState: live?.observedState ?? instance.observedState,
      }}
      name={live?.name ?? props.name}
    />
  )
}

function LiveRegistryRelayName({
  instance,
  ...props
}: InstanceNameProps & {
  instance: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, instance.id))
        .select(({ relay }) => ({
          connected: relay.lastConnectedAt !== null,
          enabled: relay.enabled,
          lastError: relay.lastError,
          name: relay.name,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      instance={{
        ...instance,
        connected: live?.connected ?? instance.connected,
        enabled: live?.enabled ?? instance.enabled,
        lastError: live ? live.lastError : instance.lastError,
      }}
      name={live?.name ?? props.name}
    />
  )
}

function LiveFleetRelayName({
  instance,
  ...props
}: InstanceNameProps & {
  instance: Extract<InstanceNameInstance, { kind: "relay" }>
}) {
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relayNodesCollectionOptions })
        .where(({ relay }) => eq(relay.relayId, instance.relayId))
        .select(({ relay }) => ({
          name: relay.relayName,
          relayStatus: relay.relayStatus,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      instance={{
        ...instance,
        relayStatus: live?.relayStatus ?? instance.relayStatus,
      }}
      name={live?.name ?? props.name}
    />
  )
}

function InstanceNameView({
  className,
  iconClassName,
  instance,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
}: InstanceNameProps) {
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
            "flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground",
            nameClassName
          )}
        >
          <span className="truncate">{name}</span>
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
