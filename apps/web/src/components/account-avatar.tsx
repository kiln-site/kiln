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

export const AccountAvatar = React.memo(function AccountAvatar({
  className,
  fallbackClassName,
  name,
  size = "sm",
}: {
  className?: string
  fallbackClassName?: string
  name: string
  size?: "default" | "sm" | "lg"
}) {
  const { data: profile } = useQuery(minecraftProfileQueryOptions(name))

  return (
    <Avatar size={size} className={cn("rounded-none", className)}>
      {profile ? (
        <AvatarImage
          src={minecraftHeadUrl(profile.id)}
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
