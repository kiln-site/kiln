import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { UserAvatar } from "@/components/account-avatar"
import { RedactedText } from "@/components/redacted-text"

// A person as Kiln shows them: their Minecraft head (initials without one),
// name, and email blurred until clicked.
export const UserIdentity = React.memo(function UserIdentity({
  accessory,
  avatarClassName,
  className,
  email,
  emailClassName,
  name,
  nameClassName,
  profileId,
}: {
  /** Badges after the name. */
  accessory?: React.ReactNode
  avatarClassName?: string
  className?: string
  /** Only for those who may see it. */
  email?: string | null
  emailClassName?: string
  name: string
  nameClassName?: string
  profileId?: string | null
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      <UserAvatar
        name={name}
        profileId={profileId ?? undefined}
        className={cn("size-9", avatarClassName)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[0.8125rem] font-semibold",
              nameClassName
            )}
          >
            {name}
          </span>
          {accessory}
        </span>
        {email ? (
          <RedactedText
            label="email address"
            value={email}
            // Padding widens the click target; the negative margin keeps
            // the text where it was.
            className={cn(
              "-mx-1 -my-1 max-w-[calc(100%+0.5rem)] self-start truncate px-1 py-1 font-mono text-xs text-muted-foreground",
              emailClassName
            )}
          />
        ) : null}
      </span>
    </span>
  )
})
