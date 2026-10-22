import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { UserIdentity } from "@/components/user-identity"

// Pieces shared by the platform Users table and a resource's people table.

/**
 * Minecraft profile IDs by user ID. Heads load after the rows; reading them
 * from context re-renders only the identity cells, not every row.
 */
export const UserProfilesContext = React.createContext<Record<string, string>>(
  {}
)

/**
 * A row's user card. A button behind it covers the whole row, so clicking
 * anywhere but an action or the email opens the person. The table gives its
 * rows `relative` and its actions cell `relative z-10`.
 */
export const UserRowIdentity = React.memo(function UserRowIdentity({
  userId,
  name,
  email,
  accessory,
  openLabel,
  onOpen,
}: {
  userId: string | null
  name: string
  email: string
  accessory?: React.ReactNode
  openLabel: string
  onOpen: () => void
}) {
  const profileId = React.useContext(UserProfilesContext)[userId ?? ""]
  return (
    <>
      <button
        type="button"
        aria-label={openLabel}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        onClick={onOpen}
      />
      <UserIdentity
        className="pointer-events-none relative w-full"
        emailClassName="pointer-events-auto relative"
        name={name}
        email={email}
        profileId={profileId}
        accessory={accessory}
      />
    </>
  )
})

const actionTones = {
  danger:
    "text-destructive/85 hover:bg-destructive/10 light:hover:bg-destructive/20 hover:text-destructive disabled:text-muted-foreground",
  warning:
    "text-amber-600/90 hover:bg-amber-500/10 light:hover:bg-amber-500/20 hover:text-amber-500 dark:text-amber-400/90",
  success:
    "text-emerald-600/90 hover:bg-emerald-500/10 light:hover:bg-emerald-500/20 hover:text-emerald-500 dark:text-emerald-400/90",
  info: "text-sky-600/90 hover:bg-sky-500/10 light:hover:bg-sky-500/20 hover:text-sky-500 dark:text-sky-400/90",
} as const

/** An icon action in a user row, coloured by what it does. */
export function UserActionButton({
  icon: Icon,
  label,
  tooltip,
  tone,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon
  label: string
  tooltip: string
  tone: keyof typeof actionTones
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so the tooltip hangs on its wrapper. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            className={cn(actionTones[tone])}
            onClick={onClick}
          >
            <Icon />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
