import * as React from "react"
import { useRouteContext } from "@tanstack/react-router"

import { Input } from "@workspace/ui/components/input"

import {
  confirmationMatches,
  type DeleteConfirmation,
} from "@/lib/delete-confirmation"
import { isDevelopmentBypassIdentity } from "@/lib/development-bypass"

export interface DeleteConfirmationState {
  /** What to send with the deletion. */
  readonly input: DeleteConfirmation
  /** Whether the typed name matches. */
  readonly matches: boolean
  readonly name: string
  readonly passwordRequired: boolean
  /** Whether everything asked for is filled in. */
  readonly ready: boolean
  readonly setConfirmation: (value: string) => void
  readonly setPassword: (value: string) => void
}

/**
 * What deleting any game server, database, App, or volume asks: its name,
 * typed, and the account password, which the development sign-in has none
 * of. The server checks both again.
 */
export function useDeleteConfirmation(name: string): DeleteConfirmationState {
  const passwordRequired = useRouteContext({
    from: "/_app",
    select: ({ user }) => !isDevelopmentBypassIdentity(user),
  })
  const [confirmation, setConfirmation] = React.useState("")
  const [password, setPassword] = React.useState("")
  const matches = confirmationMatches(confirmation, name)
  return {
    input: { confirmation, password },
    matches,
    name,
    passwordRequired,
    ready: matches && (!passwordRequired || password.length > 0),
    setConfirmation,
    setPassword,
  }
}

/** The typed name and password fields of a deletion dialog. */
export function DeleteConfirmationFields({
  confirmation,
  disabled,
}: {
  confirmation: DeleteConfirmationState
  disabled: boolean
}) {
  const id = React.useId()
  const typed = confirmation.input.confirmation
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label
          htmlFor={`${id}-name`}
          className="type-technical-label text-muted-foreground"
        >
          Type{" "}
          <span className="font-mono text-foreground normal-case">
            {confirmation.name}
          </span>{" "}
          to confirm
        </label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) =>
            confirmation.setConfirmation(event.currentTarget.value)
          }
          aria-invalid={typed.length > 0 && !confirmation.matches}
          className="bg-background"
          disabled={disabled}
          required
        />
        {typed.length > 0 && !confirmation.matches ? (
          <p className="type-meta text-destructive">That isn't its name yet.</p>
        ) : null}
      </div>
      {confirmation.passwordRequired ? (
        <div className="grid gap-1.5">
          <label
            htmlFor={`${id}-password`}
            className="type-technical-label text-muted-foreground"
          >
            Account password
          </label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            placeholder="Enter your account password"
            value={confirmation.input.password}
            onChange={(event) =>
              confirmation.setPassword(event.currentTarget.value)
            }
            className="bg-background"
            disabled={disabled}
            required
          />
        </div>
      ) : null}
    </div>
  )
}
