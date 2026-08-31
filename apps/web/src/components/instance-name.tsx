import * as React from "react"
import { and, eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { Database, RadioTower, Server } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import {
  BrickIcon,
  brickIconPresentation,
  type BrickIconDefinition,
} from "@/components/brick-icon"
import {
  instanceStatusPresentation,
  type InstanceNameInstance,
  type InstanceStatusPresentation,
} from "@/components/instance-name-presentation"
import { managedDatabasesCollectionOptions } from "@/lib/collections/managed-databases"
import { relayInstancesCollectionOptions } from "@/lib/collections/relay-instances"
import { relayNodesCollectionOptions } from "@/lib/collections/relay-nodes"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import { brickIconPresentationsQueryOptions } from "@/lib/query-options"

export type { InstanceNameInstance } from "@/components/instance-name-presentation"

interface InstanceNameProps {
  className?: string
  iconClassName?: string
  instance: InstanceNameInstance
  meta?: React.ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: React.ReactNode
  nameClassName?: string
  textClassName?: string
}

export function InstanceName(props: InstanceNameProps) {
  return <MemoInstanceName {...props} />
}

const MemoInstanceName = React.memo(function MemoInstanceName(
  props: InstanceNameProps
) {
  const { instance } = props
  if (instance.kind === "server") {
    return <LiveServerIdentity {...props} instance={instance} />
  }
  if (instance.kind === "database") {
    return <LiveDatabaseIdentity {...props} instance={instance} />
  }
  if (instance.source === "registry") {
    return <LiveRegistryRelayIdentity {...props} instance={instance} />
  }
  return <LiveFleetRelayIdentity {...props} instance={instance} />
}, instanceNamePropsEqual)

type ServerInstance = Extract<InstanceNameInstance, { kind: "server" }>
type DatabaseInstance = Extract<InstanceNameInstance, { kind: "database" }>
type RelayInstance = Extract<InstanceNameInstance, { kind: "relay" }>

function LiveServerIdentity(
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
          brickId: server.brickId,
          brickSource: server.brickSource,
          implementation: server.implementation,
          name: server.name,
          observedState: server.observedState,
          relayStatus: server.relayStatus,
        })),
  })
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      brickId={live?.brickId}
      brickSource={live?.brickSource}
      implementation={live?.implementation}
      liveName={live?.name}
      status={instanceStatusPresentation({
        ...instance,
        observedState: live?.observedState ?? instance.observedState,
        relayStatus: live?.relayStatus ?? instance.relayStatus,
      })}
    />
  )
}

function LiveDatabaseIdentity(
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

function LiveRegistryRelayIdentity(
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

function LiveFleetRelayIdentity(
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

const InstanceNameView = React.memo(function InstanceNameView({
  className,
  brickId,
  brickSource,
  iconClassName,
  implementation,
  instance,
  liveName,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
  status,
  textClassName,
}: InstanceNameProps & {
  brickId?: string
  brickSource?: string
  implementation?: string
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
        <InstanceIcon
          brickId={brickId}
          brickSource={brickSource}
          implementation={implementation}
          instance={instance}
        />
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
        textClassName={textClassName}
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
  textClassName,
}: Pick<
  InstanceNameProps,
  | "meta"
  | "metaClassName"
  | "name"
  | "nameAccessory"
  | "nameClassName"
  | "textClassName"
>) {
  return (
    <span className={cn("min-w-0 flex-1", textClassName)}>
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
  brickId,
  brickSource,
  implementation,
  instance,
}: {
  brickId?: string
  brickSource?: string
  implementation?: string
  instance: InstanceNameInstance
}) {
  if (instance.kind === "server") {
    return implementation ? (
      <LiveServerBrickIcon
        brickId={brickId}
        brickSource={brickSource}
        implementation={implementation}
      />
    ) : (
      <Server className="size-4" aria-hidden="true" />
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

const LiveServerBrickIcon = React.memo(function LiveServerBrickIcon({
  brickId,
  brickSource,
  implementation,
}: {
  brickId?: string
  brickSource?: string
  implementation: string
}) {
  const selectIcon = React.useCallback(
    (bricks: Array<BrickIconDefinition>) =>
      brickIconPresentation(bricks, {
        brickId,
        brickSource,
        implementation,
      }),
    [brickId, brickSource, implementation]
  )
  const { data: icon } = useQuery({
    ...brickIconPresentationsQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectIcon,
  })
  return (
    <BrickIcon
      id={icon?.id ?? brickId ?? implementation}
      color={icon?.color}
      iconSvg={icon?.iconSvg}
      className="size-6"
      aria-hidden="true"
    />
  )
})

function instanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps
): boolean {
  return (
    previous.className === next.className &&
    previous.iconClassName === next.iconClassName &&
    previous.meta === next.meta &&
    previous.metaClassName === next.metaClassName &&
    previous.name === next.name &&
    previous.nameAccessory === next.nameAccessory &&
    previous.nameClassName === next.nameClassName &&
    previous.textClassName === next.textClassName &&
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
  if (previous.kind === "database" && next.kind === "database") {
    return true
  }
  return previous.kind === "server" && next.kind === "server"
}

const statusToneClassName: Record<InstanceStatusPresentation["tone"], string> =
  {
    danger: "bg-destructive",
    info: "bg-sky-400",
    neutral: "bg-muted-foreground/45",
    success: "bg-emerald-400",
    warning: "bg-amber-400",
  }
