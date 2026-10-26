import * as React from "react"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import { cn } from "@workspace/ui/lib/utils"

import { useUserPictureUrl } from "@/components/icon-image"

interface UserAvatarProps {
  className?: string
  fallbackClassName?: string
  name: string
  size?: "default" | "sm" | "lg"
  /** Whose picture to show; initials without one. */
  userId?: string | null
}

/** The signed-in user's avatar; the same as any other user's. */
export const AccountAvatar = React.memo(function AccountAvatar(
  props: UserAvatarProps
) {
  return <UserAvatar {...props} />
})

/** A user's avatar: the picture they chose, or else their initials. */
export const UserAvatar = React.memo(function UserAvatar({
  className,
  fallbackClassName,
  name,
  size = "sm",
  userId,
}: UserAvatarProps) {
  const pictureUrl = useUserPictureUrl(userId)
  return (
    <Avatar
      aria-hidden="true"
      size={size}
      className={cn("rounded-none", className)}
    >
      {pictureUrl ? (
        <AvatarImage src={pictureUrl} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback
        className={cn(
          "type-label rounded-none bg-primary/12 font-bold text-primary-ink",
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
