import type { CliAccessDuration, CliAccessMode } from "@workspace/contracts"
import { Effect } from "effect"

import { revokeAccountSessionEffect } from "@/effect/account-sessions"
import {
  approveCliAuthorizationEffect,
  cliDeviceRequestIdEffect,
  denyCliAuthorizationEffect,
  revokeCliCredentialEffect,
} from "@/effect/cli-access"
import { promiseEffect } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  findBrowserSignOutTarget,
  signOutBrowserSession,
} from "@/lib/browser-accounts.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { currentActingUser } from "@/operations/acting-user"
import { exclusive, partKey, shared, userKey } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

/**
 * How people manage their own sign-ins, as operations
 * (docs/hearth-operations.md). Each holds the account it changes against an
 * administrator changing it meanwhile; a session or CLI is a part of it, so
 * ending two at once doesn't turn either away.
 */

/** One of a person's sign-ins: a browser session or a CLI. */
const signInKey = (
  userId: string,
  kind: "cli-credential" | "session",
  id: string
) => partKey(userKey(userId), `${kind}:${id}`)

/**
 * A CLI's request to be linked, by its ID: whoever answers it first decides
 * it. Not the code, which would let anyone who reads the lanes link it.
 */
const cliDeviceKey = (id: string) => `cli-device:${id}`

interface CliAnswer {
  readonly userCode: string
}

// The request a code names, for its lane; a code that names none fails in
// the run, as it always has.
const authorizeCliAnswer = Effect.fnUntraced(function* ({
  input,
  user,
}: {
  input: CliAnswer
  user: AuthenticatedUser | null
}) {
  const person = yield* signedIn(user)
  const requestId = yield* cliDeviceRequestIdEffect(input.userCode)
  return { person, requestId }
})

const cliAnswerLocks = ({
  context,
}: {
  context: { person: AuthenticatedUser; requestId: string | null }
}) => [
  shared(userKey(context.person.id)),
  ...(context.requestId ? [exclusive(cliDeviceKey(context.requestId))] : []),
]

const cliAnswerAudit = ({
  context,
}: {
  context: { requestId: string | null }
}) => (context.requestId ? { id: context.requestId, kind: "cli-device" } : null)

export const approveCliAuthorizationOperation = operation<
  CliAnswer & { duration: CliAccessDuration; mode: CliAccessMode }
>()({
  name: "cli.device.approve",
  doing: "Answering this CLI sign-in",
  authorize: authorizeCliAnswer,
  locks: cliAnswerLocks,
  // Read the account again now its lane is held: one disabled since the
  // request began mustn't link a CLI.
  run: ({ context, input }) =>
    currentActingUser(context.person.id, context.person).pipe(
      Effect.flatMap((user) =>
        approveCliAuthorizationEffect({ ...input, user })
      )
    ),
  audit: cliAnswerAudit,
})

export const denyCliAuthorizationOperation = operation<CliAnswer>()({
  name: "cli.device.deny",
  doing: "Answering this CLI sign-in",
  authorize: authorizeCliAnswer,
  locks: cliAnswerLocks,
  run: ({ context, input }) =>
    denyCliAuthorizationEffect({ ...input, user: context.person }),
  audit: cliAnswerAudit,
})

export const revokeCliCredentialOperation = operation<{
  credentialId: string
}>()({
  name: "cli.credentials.revoke",
  doing: "Unlinking this CLI",
  authorize: ({ user }) => signedIn(user),
  locks: ({ context: person, input }) => [
    exclusive(signInKey(person.id, "cli-credential", input.credentialId)),
  ],
  run: ({ context: user, input }) =>
    revokeCliCredentialEffect({ ...input, user }),
  audit: ({ input }) => ({ id: input.credentialId, kind: "cli-credential" }),
})

export const revokeAccountSessionOperation = operation<{
  sessionId: string
}>()({
  name: "auth.sessions.revoke",
  doing: "Signing out this session",
  authorize: ({ user }) => signedIn(user),
  locks: ({ context: person, input }) => [
    exclusive(signInKey(person.id, "session", input.sessionId)),
  ],
  run: ({ context: person, input }) =>
    Effect.gen(function* () {
      const change = yield* revokeAccountSessionEffect(
        person.id,
        input.sessionId
      )
      if (!change) return { revoked: false }
      yield* promiseEffect(async () => {
        const { wakeAuthorizationDelivery } =
          await import("@/lib/authorization-delivery")
        for (const relayId of change.relayIds) {
          wakeAuthorizationDelivery(relayId)
        }
      })
      return { revoked: true }
    }),
  audit: ({ context: person }) => ({ id: person.id, kind: "user" }),
  // Only a session it ended: another's is none of this person's business.
  publish: ({ exit, input }) => {
    if (exit._tag === "Success" && exit.value.revoked) {
      publishRealtimeChange({
        sessionIds: [input.sessionId],
        type: "session.revoked",
      })
    }
  },
})

/**
 * Signs one account out of this browser, which may be another person's
 * than the one active: its account is the one held and audited. Better
 * Auth ends the session, telling its pages and Relays.
 */
export const signOutBrowserAccountOperation = operation<{
  headers: Headers
  sessionId: string
}>()({
  name: "auth.browser-account.sign-out",
  doing: "Signing out this session",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.andThen(
        promiseEffect(() =>
          findBrowserSignOutTarget(input.headers, input.sessionId)
        )
      )
    ),
  locks: ({ context: target, input }) => [
    exclusive(signInKey(target.userId, "session", input.sessionId)),
  ],
  run: ({ context: target, input }) =>
    promiseEffect(() => signOutBrowserSession(input.headers, target)),
  audit: ({ context: target }) => ({ id: target.userId, kind: "user" }),
})
