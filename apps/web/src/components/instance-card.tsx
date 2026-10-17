import * as React from "react"
import type { InstanceReference } from "@workspace/contracts"
import { Boxes, Database, RadioTower, Server } from "lucide-react"

import { IdentityName } from "@/components/identity-name"
import type {
  IdentityNameProps,
  IdentityStatusPresentation,
} from "@/components/identity-name"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { instanceStatusPresentation } from "@/components/instance-name-presentation"
import { InstanceFavoriteStar } from "@/components/instance-favorite"
import { StatusIndicator } from "@/components/status-indicator"
import { useInstanceState, type InstanceState } from "@/lib/instance-state"

export type { InstanceNameInstance } from "@/components/instance-name-presentation"

export type InstanceIdentity = InstanceReference & {
  brickId?: string
  brickSource?: string
  implementation?: string
}

export interface InstanceCardProps extends Omit<
  IdentityNameProps,
  "icon" | "status"
> {
  instance: InstanceIdentity
  iconSizeClassName?: string
  showFavorite?: boolean
  showStatus?: boolean
}

function instanceStatePresentation(
  state: InstanceState
): IdentityStatusPresentation {
  if (state.phase === "checking")
    return { label: "Checking", tone: "neutral", pulse: true }
  if (state.phase === "error")
    return { label: "Unknown", detail: state.error.message, tone: "neutral" }
  const { observation } = state
  if (observation.kind === "relay") {
    return instanceStatusPresentation({
      ...observation,
      kind: "relay",
      relayStatus: observation.reachability,
      updating: observation.updating,
    })
  }
  if (observation.reachability === "checking")
    return { label: "Checking", tone: "neutral", pulse: true }
  if (observation.reachability === "paused")
    return { label: "Paused", tone: "neutral" }
  if (observation.reachability === "connected" && observation.inventory === "missing")
    return { label: "Missing", detail: "Resource is missing from its Relay", tone: "danger" }
  return instanceStatusPresentation({
    ...observation,
    kind: observation.kind,
    inventoryStatus: observation.inventory,
    observedState: observation.runtime ?? undefined,
    relayStatus: observation.reachability,
    relayUpdating: observation.updating,
  })
}

export const InstanceStatus = React.memo(function InstanceStatus({
  instance,
}: {
  instance: InstanceReference
}) {
  return (
    <StatusIndicator
      status={instanceStatePresentation(useInstanceState(instance))}
    />
  )
})

export const InstanceCard = React.memo(function InstanceCard({
  instance,
  iconSizeClassName,
  showFavorite = true,
  showStatus = true,
  nameAccessory,
  meta = instance.id.slice(0, 8),
  ...props
}: InstanceCardProps) {
  const state = useInstanceState(instance, showStatus)
  const Icon =
    instance.kind === "app"
      ? Boxes
      : instance.kind === "database"
        ? Database
        : instance.kind === "relay"
          ? RadioTower
          : Server
  return (
    <IdentityName
      {...props}
      meta={meta}
      icon={
        instance.kind === "server" && instance.implementation ? (
          <LiveServerBrickIcon
            brickId={instance.brickId}
            brickSource={instance.brickSource}
            implementation={instance.implementation}
            className={iconSizeClassName}
          />
        ) : (
          <Icon className={iconSizeClassName ?? "size-4"} aria-hidden="true" />
        )
      }
      nameAccessory={
        showFavorite ? (
          <>
            <InstanceFavoriteStar
              id={instance.id}
              kind={instance.kind}
              relayId={instance.relayId}
            />
            {nameAccessory}
          </>
        ) : (
          nameAccessory
        )
      }
      status={showStatus ? instanceStatePresentation(state) : undefined}
    />
  )
})
