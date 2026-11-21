import { useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import { createContext, use, useEffect, useState, type ReactNode } from "react"

import {
  apiRequest,
  cliRevokeResponseSchema,
  type HearthSession,
} from "../api/hearth"
import { clearRecentPages } from "../lib/recent-pages"
import { clearSession, loadSession, saveSession } from "./store"

type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly session: HearthSession }

interface SessionContextValue {
  readonly state: SessionState
  readonly signIn: (session: HearthSession) => Promise<void>
  readonly signOut: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider(props: { readonly children: ReactNode }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<SessionState>({ status: "loading" })

  useEffect(() => {
    void Effect.runPromise(
      loadSession().pipe(
        Effect.match({
          onFailure: () => setState({ status: "signed-out" }),
          onSuccess: (session) =>
            setState(
              session
                ? { status: "signed-in", session }
                : { status: "signed-out" }
            ),
        })
      )
    )
  }, [])

  const signIn = (session: HearthSession) =>
    Effect.runPromise(
      saveSession(session).pipe(
        Effect.ignore,
        Effect.map(() => setState({ status: "signed-in", session }))
      )
    )

  const signOut = () => {
    const current = state.status === "signed-in" ? state.session : null
    return Effect.runPromise(
      Effect.gen(function* () {
        // Revoke the credential on Hearth, but never keep someone signed in
        // because Hearth is unreachable.
        if (current)
          yield* apiRequest(current, "credential", cliRevokeResponseSchema, {
            method: "DELETE",
          }).pipe(Effect.ignore)
        yield* clearSession().pipe(Effect.ignore)
        clearRecentPages()
        queryClient.clear()
        setState({ status: "signed-out" })
      })
    )
  }

  return (
    <SessionContext value={{ state, signIn, signOut }}>
      {props.children}
    </SessionContext>
  )
}

export function useSessionContext(): SessionContextValue {
  const value = use(SessionContext)
  if (!value) throw new Error("useSessionContext needs a SessionProvider")
  return value
}

/** The signed-in session. Only screens behind sign-in call this. */
export function useSession(): HearthSession {
  const { state } = useSessionContext()
  if (state.status !== "signed-in")
    throw new Error("useSession called while signed out")
  return state.session
}

export const useIsSignedIn = () =>
  useSessionContext().state.status === "signed-in"
export const useIsSignedOut = () =>
  useSessionContext().state.status === "signed-out"
