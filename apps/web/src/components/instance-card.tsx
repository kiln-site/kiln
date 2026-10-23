import * as React from "react"
import type { InstanceReference } from "@workspace/contracts"

import { IdentityName } from "@/components/identity-name"
import type {
  IdentityNameProps,
  IdentityStatusPresentation,
} from "@/components/identity-name"
import { instanceKindIcons } from "@/components/instance-kind-icon"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { InstanceFavoriteStar } from "@/components/instance-favorite"
import { StatusIndicator } from "@/components/status-indicator"
import { useInstanceState, type InstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"

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
  state?: InstanceState
  /** A fixed status, like a pending invitation's, in place of live state. */
  status?: IdentityStatusPresentation
}

export const InstanceStatus = React.memo(function InstanceStatus({
  instance,
  state,
}: {
  instance: InstanceReference
  state?: InstanceState
}) {
  return state ? (
    <StatusIndicator status={instanceStatePresentation(state)} />
  ) : (
    <LiveInstanceStatus instance={instance} />
  )
})

function LiveInstanceStatus({ instance }: { instance: InstanceReference }) {
  return (
    <StatusIndicator
      status={instanceStatePresentation(useInstanceState(instance))}
    />
  )
}

export const InstanceCard = React.memo(function InstanceCard(
  props: InstanceCardProps
) {
  return props.state || props.status || props.showStatus === false ? (
    <InstanceCardView {...props} />
  ) : (
    <LiveInstanceCard {...props} />
  )
})

function LiveInstanceCard(props: InstanceCardProps) {
  const state = useInstanceState(props.instance)
  return <InstanceCardView {...props} state={state} />
}

const InstanceCardView = React.memo(function InstanceCardView({
  instance,
  iconSizeClassName,
  showFavorite = true,
  showStatus = true,
  nameAccessory,
  meta = instance.id.slice(0, 8),
  state = { phase: "checking" },
  status,
  ...props
}: InstanceCardProps) {
  const Icon = instanceKindIcons[instance.kind]
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
      status={
        showStatus ? (status ?? instanceStatePresentation(state)) : undefined
      }
    />
  )
})
