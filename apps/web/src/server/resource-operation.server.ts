import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  lockAs,
  resourceKey,
  type LaneLock,
  type LockPolicy,
} from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

/**
 * A change to one game server, database or App, as an operation, holding
 * the resource as `lock` says. The person's permission on it is checked
 * before any lane is taken, so a refusal tells nothing to one who may not
 * change it; the run keeps any further checks.
 */
export const resourceOperation = <
  Input extends { readonly relayId: string },
  A,
>(definition: {
  readonly kind: "app" | "database" | "instance"
  readonly id: (input: Input) => string
  readonly name: string
  readonly doing: string | ((input: Input) => string)
  readonly permission: (input: Input) => AccessPermission
  /**
   * Null for one that hands the change to a durable operation of its own,
   * which holds the locks, and whose Relay commands are what's audited: this
   * can end, as with a restart, while the change goes on.
   */
  readonly lock: LockPolicy | null | ((input: Input) => LockPolicy)
  readonly alsoLocks?: (input: Input) => ReadonlyArray<LaneLock>
  readonly run: (user: AuthenticatedUser, input: Input) => Promise<A>
}) =>
  operation<Input>()({
    name: definition.name,
    doing: definition.doing,
    authorize: ({ input, user }) =>
      signedIn(user).pipe(
        Effect.tap((person) =>
          promiseEffect(() =>
            requireRelayPermission({
              [`${definition.kind}Id`]: definition.id(input),
              permission: definition.permission(input),
              relayId: input.relayId,
              user: person,
            })
          )
        )
      ),
    locks: ({ input }) => {
      const policy =
        typeof definition.lock === "function"
          ? definition.lock(input)
          : definition.lock
      return [
        ...(policy === null
          ? []
          : [
              lockAs(
                resourceKey(
                  definition.kind,
                  input.relayId,
                  definition.id(input)
                ),
                policy
              ),
            ]),
        ...(definition.alsoLocks?.(input) ?? []),
      ]
    },
    run: ({ context: user, input }) =>
      promiseEffect(() => definition.run(user, input)),
    audit: ({ input }) =>
      definition.lock === null
        ? null
        : {
            id: definition.id(input),
            kind: definition.kind,
            relayId: input.relayId,
          },
  })
