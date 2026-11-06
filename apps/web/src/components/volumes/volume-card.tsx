import * as React from "react"
import type { RelayVolume } from "@workspace/contracts"

import {
  IdentityName,
  type IdentityNameProps,
} from "@/components/identity-name"
import { RelayKindIcon, VolumeKindIcon } from "@/components/instance-kind-icon"
import { formatBytes } from "@/lib/format-bytes"

export interface VolumeCardProps extends Omit<IdentityNameProps, "icon"> {
  // In place of the volume's own, for what's mounted beside volumes.
  icon?: React.ReactNode
  kind?: RelayVolume["kind"]
}

// A volume's identity, as an instance's card is an instance's: what it's
// called and a line about it. What uses it isn't part of it; a table gives
// that a column of its own.
export const VolumeCard = React.memo(function VolumeCard({
  icon,
  kind,
  ...props
}: VolumeCardProps) {
  return (
    <IdentityName
      {...props}
      icon={
        icon ??
        (kind === "relay" ? (
          <RelayKindIcon className="size-4" aria-hidden="true" />
        ) : (
          <VolumeKindIcon className="size-4" aria-hidden="true" />
        ))
      }
    />
  )
})

/** A volume's line in a picker: its size, then its short ID. */
export function volumeCardMeta(
  volume: Pick<RelayVolume, "dockerName" | "id" | "sizeBytes">
): string {
  return [
    volume.sizeBytes === null ? null : formatBytes(volume.sizeBytes),
    volume.id?.slice(0, 8) ?? volume.dockerName,
  ]
    .filter(Boolean)
    .join(" · ")
}
