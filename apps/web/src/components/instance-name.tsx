import * as React from "react"
import { and, eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { Database, RadioTower, Server } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { BrickIcon } from "@/components/brick-icon"
import {
  instanceStatusPresentation,
  type InstanceNameInstance,
  type InstanceStatusPresentation,
} from "@/components/instance-name-presentation"
import { managedDatabaseDirectoryCollectionOptions } from "@/lib/collections/managed-database-directory"
import { managedDatabasesCollectionOptions } from "@/lib/collections/managed-databases"
import { relayInstancesCollectionOptions } from "@/lib/collections/relay-instances"
import { relayNodesCollectionOptions } from "@/lib/collections/relay-nodes"
import { relaysCollectionOptions } from "@/lib/collections/relays"

export type { InstanceNameInstance } from "@/components/instance-name-presentation"

interface InstanceNameProps {
  className?: string
  iconClassName?: string
  instance: InstanceNameInstance
  live?: boolean
  meta?: React.ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: React.ReactNode
  nameClassName?: string
  showStatus?: boolean
}

export function InstanceName(props: InstanceNameProps) {
  return <MemoInstanceName {...props} />
}

const MemoInstanceName = React.memo(function MemoInstanceName(
  props: InstanceNameProps
) {
  const { instance, live = true, showStatus = true } = props
  if (!live) {
    return (
      <InstanceNameView
        {...props}
        status={showStatus ? instanceStatusPresentation(instance) : undefined}
      />
    )
  }
  if (instance.kind === "server") {
    return showStatus ? (
      <LiveServerIdentityWithStatus {...props} instance={instance} />
    ) : (
      <LiveServerIdentityNameOnly {...props} instance={instance} />
    )
  }
  if (instance.kind === "database") {
    return showStatus ? (
      <LiveDatabaseIdentityWithStatus {...props} instance={instance} />
    ) : (
      <LiveDatabaseIdentityNameOnly {...props} instance={instance} />
    )
  }
  if (instance.source === "registry") {
    return showStatus ? (
      <LiveRegistryRelayIdentityWithStatus {...props} instance={instance} />
    ) : (
      <LiveRegistryRelayIdentityNameOnly {...props} instance={instance} />
    )
  }
  return showStatus ? (
    <LiveFleetRelayIdentityWithStatus {...props} instance={instance} />
  ) : (
    <LiveFleetRelayIdentityNameOnly {...props} instance={instance} />
  )
}, instanceNamePropsEqual)

type ServerInstance = Extract<InstanceNameInstance, { kind: "server" }>
type DatabaseInstance = Extract<InstanceNameInstance, { kind: "database" }>
type RelayInstance = Extract<InstanceNameInstance, { kind: "relay" }>

function LiveServerIdentityWithStatus(
  props: InstanceNameProps & { instance: ServerInstance }
) {
  const { instance } = props
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
      liveName={live?.name}
      status={instanceStatusPresentation({
        ...instance,
        observedState: live?.observedState ?? instance.observedState,
        relayStatus: live?.relayStatus ?? instance.relayStatus,
      })}
    />
  )
}

function LiveServerIdentityNameOnly(
  props: InstanceNameProps & { instance: ServerInstance }
) {
  const { instance } = props
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ server: relayInstancesCollectionOptions })
        .where(({ server }) =>
          and(eq(server.id, instance.id), eq(server.relayId, instance.relayId))
        )
        .select(({ server }) => ({ name: server.name })),
  })
  return <InstanceNameView {...props} liveName={data?.[0]?.name} />
}

function LiveDatabaseIdentityWithStatus(
  props: InstanceNameProps & { instance: DatabaseInstance }
) {
  const { instance } = props
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
      liveName={live?.name}
      status={instanceStatusPresentation({
        ...instance,
        inventoryStatus: live?.inventoryStatus ?? instance.inventoryStatus,
        observedState: live?.observedState ?? instance.observedState,
      })}
    />
  )
}

function LiveDatabaseIdentityNameOnly(
  props: InstanceNameProps & { instance: DatabaseInstance }
) {
  const { instance } = props
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ database: managedDatabaseDirectoryCollectionOptions })
        .where(({ database }) =>
          and(
            eq(database.id, instance.id),
            eq(database.relayId, instance.relayId)
          )
        )
        .select(({ database }) => ({ name: database.name })),
  })
  return <InstanceNameView {...props} liveName={data?.[0]?.name} />
}

function LiveRegistryRelayIdentityWithStatus(
  props: InstanceNameProps & { instance: RelayInstance }
) {
  const { instance } = props
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, instance.id))
        .select(({ relay }) => ({
          enabled: relay.enabled,
          lastConnectedAt: relay.lastConnectedAt,
          lastError: relay.lastError,
          name: relay.name,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      liveName={live?.name}
      status={instanceStatusPresentation({
        ...instance,
        connected: live ? live.lastConnectedAt !== null : instance.connected,
        enabled: live?.enabled ?? instance.enabled,
        lastError: live ? live.lastError : instance.lastError,
      })}
    />
  )
}

function LiveRegistryRelayIdentityNameOnly(
  props: InstanceNameProps & { instance: RelayInstance }
) {
  const { instance } = props
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, instance.id))
        .select(({ relay }) => ({ name: relay.name })),
  })
  return <InstanceNameView {...props} liveName={data?.[0]?.name} />
}

function LiveFleetRelayIdentityWithStatus(
  props: InstanceNameProps & { instance: RelayInstance }
) {
  const { instance } = props
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
      liveName={live?.name}
      status={instanceStatusPresentation({
        ...instance,
        relayStatus: live?.relayStatus ?? instance.relayStatus,
      })}
    />
  )
}

function LiveFleetRelayIdentityNameOnly(
  props: InstanceNameProps & { instance: RelayInstance }
) {
  const { instance } = props
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relayNodesCollectionOptions })
        .where(({ relay }) => eq(relay.relayId, instance.relayId))
        .select(({ relay }) => ({ name: relay.relayName })),
  })
  return <InstanceNameView {...props} liveName={data?.[0]?.name} />
}

const InstanceNameView = React.memo(function InstanceNameView({
  className,
  iconClassName,
  instance,
  liveName,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
  status,
}: InstanceNameProps & {
  liveName?: string
  status?: InstanceStatusPresentation
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground",
          iconClassName
        )}
      >
        <InstanceIcon instance={instance} />
        {status ? (
          <InstanceStatus label={status.label} tone={status.tone} />
        ) : null}
      </span>
      <InstanceText
        meta={meta}
        metaClassName={metaClassName}
        name={liveName ?? name}
        nameAccessory={nameAccessory}
        nameClassName={nameClassName}
      />
    </span>
  )
})

const InstanceText = React.memo(function InstanceText({
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
}: Pick<
  InstanceNameProps,
  "meta" | "metaClassName" | "name" | "nameAccessory" | "nameClassName"
>) {
  return (
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
    </span>
  )
})

const InstanceStatus = React.memo(function InstanceStatus({
  label,
  tone,
}: InstanceStatusPresentation) {
  return (
    <>
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
          statusToneClassName[tone]
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Status: {label}</span>
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

function instanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps
): boolean {
  return (
    previous.className === next.className &&
    previous.iconClassName === next.iconClassName &&
    (previous.live ?? true) === (next.live ?? true) &&
    previous.meta === next.meta &&
    previous.metaClassName === next.metaClassName &&
    previous.name === next.name &&
    previous.nameAccessory === next.nameAccessory &&
    previous.nameClassName === next.nameClassName &&
    (previous.showStatus ?? true) === (next.showStatus ?? true) &&
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
    return (
      previous.source === next.source &&
      previous.connected === next.connected &&
      previous.enabled === next.enabled &&
      previous.lastError === next.lastError &&
      previous.relayStatus === next.relayStatus
    )
  }
  if (previous.kind === "database" && next.kind === "database") {
    return (
      previous.inventoryStatus === next.inventoryStatus &&
      previous.observedState === next.observedState
    )
  }
  if (previous.kind !== "server" || next.kind !== "server") return false
  return (
    previous.icon?.id === next.icon?.id &&
    previous.icon?.color === next.icon?.color &&
    previous.icon?.iconSvg === next.icon?.iconSvg &&
    previous.observedState === next.observedState &&
    previous.relayStatus === next.relayStatus
  )
}

const statusToneClassName: Record<InstanceStatusPresentation["tone"], string> =
  {
    danger: "bg-destructive",
    info: "bg-sky-400",
    neutral: "bg-muted-foreground/45",
    success: "bg-emerald-400",
    warning: "bg-amber-400",
  }
