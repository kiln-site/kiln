import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  exclusive,
  partKey,
  resourceKey,
  shared,
  type LaneLock,
} from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

/**
 * How a change holds its resource (docs/hearth-operations.md):
 * - `"whole"`: replacing or removing it. Everything else on it is turned
 *   away until it ends.
 * - `{ part }`: one kind of everyday change, such as `"power"`, applied on
 *   the Relay and saved in Hearth in turn. Another of the same kind waits
 *   for it; other work on the resource doesn't.
 * - `"shared"`: everyday work the Relay or the database already keeps in
 *   order. Only replacing or removing the resource stops it.
 */
export type ResourceLockPolicy = "shared" | "whole" | { readonly part: string }

export function resourceLock(
  key: string,
  policy: ResourceLockPolicy
): LaneLock {
  if (policy === "whole") return exclusive(key)
  if (policy === "shared") return shared(key)
  return exclusive(partKey(key, policy.part))
}

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
  readonly lock: ResourceLockPolicy
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
    locks: ({ input }) => [
      resourceLock(
        resourceKey(definition.kind, input.relayId, definition.id(input)),
        definition.lock
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
