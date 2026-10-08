import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import { cn } from "@workspace/ui/lib/utils"

import { minecraftHeadUrl } from "@/lib/minecraft-profile"
import { minecraftProfileQueryOptions } from "@/lib/query-options"

interface UserAvatarProps {
  className?: string
  fallbackClassName?: string
  name: string
  size?: "default" | "sm" | "lg"
}

/** The signed-in user's avatar; resolves their Minecraft head. */
export const AccountAvatar = React.memo(function AccountAvatar(
  props: UserAvatarProps
) {
  const { data: profile } = useQuery(minecraftProfileQueryOptions(props.name))

  return <UserAvatar {...props} profileId={profile?.id} />
})

/** Any user's avatar from an already resolved Minecraft profile. */
export const UserAvatar = React.memo(function UserAvatar({
  className,
  fallbackClassName,
  name,
  profileId,
  size = "sm",
}: UserAvatarProps & { profileId?: string }) {
  return (
    <Avatar
      aria-hidden="true"
      size={size}
      className={cn("rounded-none", className)}
    >
      {profileId ? (
        <AvatarImage
          src={minecraftHeadUrl(profileId)}
          alt=""
          referrerPolicy="no-referrer"
          className={size === "lg" ? "[image-rendering:pixelated]" : undefined}
        />
      ) : null}
      <AvatarFallback
        className={cn(
          "type-label rounded-none bg-primary/12 font-bold text-primary",
          fallbackClassName
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
})

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("")
}
