import * as React from "react"
import { and, eq } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { IdentityName } from "@/components/identity-name"
import { managedDatabasesCollectionOptions } from "@/lib/collections/managed-databases"
import { relayInstancesCollectionOptions } from "@/lib/collections/relay-instances"
import { relayNodesCollectionOptions } from "@/lib/collections/relay-nodes"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import {
  brickIconPresentationsQueryOptions,
  relayConnectionQueryOptions,
  type RelayConnection,
} from "@/lib/query-options"
import { relayConnectionReachability } from "@/lib/relay-selectors"

export type { InstanceNameInstance } from "@/components/instance-name-presentation"

interface InstanceNameProps {
  className?: string
  iconClassName?: string
  iconSizeClassName?: string
  instance: InstanceNameInstance
  meta?: React.ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: React.ReactNode
  nameClassName?: string
  showStatus?: boolean
  statusClassName?: string
  textClassName?: string
}

export function InstanceName(props: InstanceNameProps) {
  return <MemoInstanceName {...props} />
}

const MemoInstanceName = React.memo(
  StaticInstanceName,
  staticInstanceNamePropsEqual
)

export function LiveInstanceName(props: InstanceNameProps) {
  return <MemoLiveInstanceName {...props} />
}

const MemoLiveInstanceName = React.memo(function MemoLiveInstanceName(
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
}, liveInstanceNamePropsEqual)

type ServerInstance = Extract<InstanceNameInstance, { kind: "server" }>
type DatabaseInstance = Extract<InstanceNameInstance, { kind: "database" }>
type RelayInstance = Extract<InstanceNameInstance, { kind: "relay" }>

function StaticInstanceName(props: InstanceNameProps) {
  const { instance } = props
  return (
    <InstanceNameView
      {...props}
      brickId={instance.kind === "server" ? instance.brickId : undefined}
      brickSource={
        instance.kind === "server" ? instance.brickSource : undefined
      }
      implementation={
        instance.kind === "server" ? instance.implementation : undefined
      }
      status={
        props.showStatus === false
          ? undefined
          : instanceStatusPresentation(instance)
      }
    />
  )
}

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
      brickId={live?.brickId ?? instance.brickId}
      brickSource={live?.brickSource ?? instance.brickSource}
      implementation={live?.implementation ?? instance.implementation}
      liveName={live?.name}
      status={
        props.showStatus === false
          ? undefined
          : instanceStatusPresentation({
              ...instance,
              observedState: live?.observedState ?? instance.observedState,
              relayStatus: live?.relayStatus ?? instance.relayStatus,
            })
      }
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
      status={
        props.showStatus === false
          ? undefined
          : instanceStatusPresentation({
              ...instance,
              inventoryStatus:
                live?.inventoryStatus ?? instance.inventoryStatus,
              observedState: live?.observedState ?? instance.observedState,
            })
      }
    />
  )
}

function LiveRegistryRelayIdentity(
  props: InstanceNameProps & { instance: RelayInstance }
) {
  const { instance } = props
  const queryClient = useQueryClient()
  const { data } = useLiveQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .where(({ relay }) => eq(relay.id, instance.id))
        .select(({ relay }) => ({
          enabled: relay.enabled,
          lastError: relay.lastError,
          name: relay.name,
        })),
  })
  const selectRelayStatus = React.useCallback(
    (connection: RelayConnection) =>
      relayConnectionReachability(connection, instance.id),
    [instance.id]
  )
  const relayStatusQuery = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectRelayStatus,
  })
  const relayStatus =
    relayStatusQuery.data ??
    (relayStatusQuery.isPending ? "checking" : "unknown")
  const live = data?.[0]
  return (
    <InstanceNameView
      {...props}
      liveName={live?.name}
      status={
        props.showStatus === false
          ? undefined
          : instanceStatusPresentation({
              ...instance,
              connected: undefined,
              enabled: live?.enabled ?? instance.enabled,
              lastError:
                relayStatus === "unreachable"
                  ? (live?.lastError ?? instance.lastError)
                  : null,
              relayStatus,
            })
      }
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
      status={
        props.showStatus === false
          ? undefined
          : instanceStatusPresentation({
              ...instance,
              relayStatus: live?.relayStatus ?? instance.relayStatus,
            })
      }
    />
  )
}

const InstanceNameView = React.memo(function InstanceNameView({
  className,
  brickId,
  brickSource,
  iconClassName,
  iconSizeClassName,
  implementation,
  instance,
  liveName,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
  status,
  statusClassName,
  textClassName,
}: InstanceNameProps & {
  brickId?: string
  brickSource?: string
  implementation?: string
  liveName?: string
  status?: InstanceStatusPresentation
}) {
  return (
    <IdentityName
      className={className}
      icon={
        <InstanceIcon
          brickId={brickId}
          brickSource={brickSource}
          iconSizeClassName={iconSizeClassName}
          implementation={implementation}
          instance={instance}
        />
      }
      iconClassName={iconClassName}
      meta={meta}
      metaClassName={metaClassName}
      name={liveName ?? name}
      nameAccessory={nameAccessory}
      nameClassName={nameClassName}
      status={status}
      statusClassName={statusClassName}
      textClassName={textClassName}
    />
  )
})

const InstanceIcon = React.memo(function InstanceIcon({
  brickId,
  brickSource,
  iconSizeClassName,
  implementation,
  instance,
}: {
  brickId?: string
  brickSource?: string
  iconSizeClassName?: string
  implementation?: string
  instance: InstanceNameInstance
}) {
  if (instance.kind === "server") {
    return implementation ? (
      <LiveServerBrickIcon
        brickId={brickId}
        brickSource={brickSource}
        className={iconSizeClassName}
        implementation={implementation}
      />
    ) : (
      <Server className={cn("size-4", iconSizeClassName)} aria-hidden="true" />
    )
  }
  const Icon =
    instance.kind === "database"
      ? Database
      : instance.kind === "relay"
        ? RadioTower
        : Server
  return <Icon className={cn("size-4", iconSizeClassName)} aria-hidden="true" />
})

const LiveServerBrickIcon = React.memo(function LiveServerBrickIcon({
  brickId,
  brickSource,
  className,
  implementation,
}: {
  brickId?: string
  brickSource?: string
  className?: string
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
      className={cn("size-6", className)}
      aria-hidden="true"
    />
  )
})

function staticInstanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps
): boolean {
  return instanceNamePropsEqual(previous, next, false)
}

function liveInstanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps
): boolean {
  return instanceNamePropsEqual(previous, next, true)
}

function instanceNamePropsEqual(
  previous: InstanceNameProps,
  next: InstanceNameProps,
  live: boolean
): boolean {
  return (
    previous.className === next.className &&
    previous.iconClassName === next.iconClassName &&
    previous.iconSizeClassName === next.iconSizeClassName &&
    previous.meta === next.meta &&
    previous.metaClassName === next.metaClassName &&
    previous.name === next.name &&
    previous.nameAccessory === next.nameAccessory &&
    previous.nameClassName === next.nameClassName &&
    previous.showStatus === next.showStatus &&
    previous.statusClassName === next.statusClassName &&
    previous.textClassName === next.textClassName &&
    instancePresentationEqual(previous.instance, next.instance, live)
  )
}

function instancePresentationEqual(
  previous: InstanceNameInstance,
  next: InstanceNameInstance,
  live: boolean
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
      (live ||
        (previous.connected === next.connected &&
          previous.enabled === next.enabled &&
          previous.lastError === next.lastError &&
          previous.relayStatus === next.relayStatus))
    )
  }
  if (previous.kind === "database" && next.kind === "database") {
    return (
      live ||
      (previous.inventoryStatus === next.inventoryStatus &&
        previous.observedState === next.observedState)
    )
  }
  if (previous.kind !== "server" || next.kind !== "server") return false
  return (
    previous.brickId === next.brickId &&
    previous.brickSource === next.brickSource &&
    previous.implementation === next.implementation &&
    (live ||
      (previous.observedState === next.observedState &&
        previous.relayStatus === next.relayStatus))
  )
}
