import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { exclusive, resourceKey, type LaneLock } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

/**
 * A change to one game server or database, as an operation: it holds the
 * resource whole, which covers what its work reaches under it, such as its
 * DNS (`#dns`), and refuses or waits for its deletion. The person's
 * permission on it is checked before any lane is taken, so a refusal tells
 * nothing to one who may not change it; the run keeps any further checks.
 */
export const resourceOperation = <
  Input extends { readonly relayId: string },
  A,
>(definition: {
  readonly kind: "database" | "instance"
  readonly id: (input: Input) => string
  readonly name: string
  readonly doing: string | ((input: Input) => string)
  readonly permission: (input: Input) => AccessPermission
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
              [definition.kind === "instance" ? "instanceId" : "databaseId"]:
                definition.id(input),
              permission: definition.permission(input),
              relayId: input.relayId,
              user: person,
            })
          )
        )
      ),
    locks: ({ input }) => [
      exclusive(
        resourceKey(definition.kind, input.relayId, definition.id(input))
      ),
      ...(definition.alsoLocks?.(input) ?? []),
    ],
    run: ({ context: user, input }) =>
      promiseEffect(() => definition.run(user, input)),
    audit: ({ input }) => ({
      id: definition.id(input),
      kind: definition.kind,
      relayId: input.relayId,
    }),
  })
