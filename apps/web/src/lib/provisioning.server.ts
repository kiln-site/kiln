import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"

// Hearth's half of provisioning any kind of instance on a Relay: it prepares
// a job, records the instance, and claims the job, and undoes the record
// only once the Relay confirms the job won't run.

/** Cancels a prepared job, and drops Hearth's record once it's cancelled. */
export function compensatePreparedProvisioning(
  cancel: () => Promise<boolean>,
  unregister: () => Promise<void>
) {
  return promiseEffect(cancel).pipe(
    Effect.flatMap((cancelled) =>
      cancelled ? promiseEffect(unregister) : Effect.void
    ),
    Effect.catch(() => Effect.void)
  )
}

/**
 * Undoes a prepare that may or may not have reached the Relay. Once the
 * Relay answers the cancel, no job can run, so Hearth's record goes too;
 * if it can't be reached, the record stays so the instance can be deleted.
 */
export function abandonPreparedProvisioning(
  cancel: () => Promise<boolean>,
  unregister: () => Promise<void>
) {
  return promiseEffect(cancel).pipe(
    Effect.andThen(promiseEffect(unregister)),
    Effect.catch(() => Effect.void)
  )
}

/** The instance ID a retried request with the same key provisions again. */
export function provisioningInstanceId(idempotencyKey: string): string {
  const hex = idempotencyKey.replaceAll("-", "")
  return `${hex}${hex.slice(0, 8)}`
}

/**
 * Claims a prepared job. A claim that fails is cancelled; Hearth keeps its
 * record unless the Relay confirms the cancel, since the job may be running.
 * `unconfirmed` says what to do when neither is certain.
 */
export function claimPreparedProvisioning(input: {
  cancel: () => Promise<boolean>
  claim: () => Promise<unknown>
  unconfirmed: string
  unregister: () => Promise<void>
}): Promise<void> {
  return Effect.runPromise(
    promiseEffect(input.claim).pipe(
      Effect.asVoid,
      Effect.matchEffect({
        onFailure: (claimFailure) =>
          promiseEffect(input.cancel).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.fail(
                  new Error(
                    `Kiln could not confirm whether the Relay accepted provisioning. ${input.unconfirmed} ${
                      claimFailure instanceof Error
                        ? claimFailure.message
                        : "Relay claim failed"
                    }`,
                    { cause: claimFailure }
                  )
                ),
              onSuccess: (cancelled) =>
                cancelled
                  ? promiseEffect(input.unregister).pipe(
                      Effect.catch(() => Effect.void),
                      Effect.andThen(Effect.fail(claimFailure))
                    )
                  : Effect.void,
            })
          ),
        onSuccess: () => Effect.void,
      })
    )
  )
}
