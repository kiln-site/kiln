import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import { minecraftHeadUrl } from "@/lib/minecraft-profile"
import { minecraftProfileQueryOptions } from "@/lib/query-options"

interface UserAvatarProps {
  name: string
  profileId?: string
}

export const UserAvatar = React.memo(function UserAvatar({
  name,
  profileId,
}: UserAvatarProps) {
  return (
    <Avatar aria-hidden="true" size="sm" className="rounded-none">
      {profileId ? (
        <AvatarImage
          src={minecraftHeadUrl(profileId)}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : null}
      <AvatarFallback className="type-label rounded-none bg-primary/12 font-bold text-primary">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
})

export const CurrentUserAvatar = React.memo(function CurrentUserAvatar({
  name,
}: {
  name: string
}) {
  const { data: profile } = useQuery(minecraftProfileQueryOptions(name))

  return <UserAvatar name={name} profileId={profile?.id} />
})

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("")
}
