import { BadgeCheck } from "lucide-react"

import { UserAvatar } from "@/components/account-avatar"
import { HearthMark } from "@/components/hearth-mark"
import { RedactedText } from "@/components/redacted-text"

// Who owns a resource, in its Info rail, with their email blurred until
// clicked. A resource no one owns, like a Relay set up with Kiln itself, is
// the platform's.
export function OwnerCard({
  email,
  name,
  profileId,
}: {
  // Only for those who may see it.
  email: string | null
  // Null when the platform manages the resource.
  name: string | null
  // The owner's Minecraft profile, for their head; initials without one.
  profileId?: string | null
}) {
  return (
    <section className="mt-6 flex min-w-0 items-center gap-3 border bg-background/45 p-3 first:mt-0">
      {name ? (
        <UserAvatar
          name={name}
          profileId={profileId ?? undefined}
          className="size-9"
        />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center bg-primary/12">
          <HearthMark className="size-5" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {name ? (
          <span className="truncate text-[0.8125rem] font-semibold">
            {name}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[0.8125rem] font-semibold">
            Kiln
            <BadgeCheck
              aria-label="Verified"
              className="size-3.5 shrink-0 text-primary"
            />
          </span>
        )}
        {!name ? (
          <span className="truncate text-xs text-muted-foreground">
            Platform managed
          </span>
        ) : email ? (
          <RedactedText
            label="email address"
            value={email}
            className="max-w-full truncate font-mono text-xs text-muted-foreground"
          />
        ) : null}
      </div>
      <span className="type-technical-label shrink-0 self-start text-muted-foreground/80">
        Owner
      </span>
    </section>
  )
}
