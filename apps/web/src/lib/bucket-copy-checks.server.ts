import { Clock, Effect, Semaphore } from "effect"
import { logException } from "@workspace/telemetry"

import {
  headS3BackupObject,
  loadBackupStorageCredentialEffect,
  s3StatusOf,
} from "@/backups/destinations/s3"
import {
  settleBucketCopyEffect,
  waitingBucketCopiesEffect,
} from "@/effect/backups"
import { runAppEffect } from "@/effect/runtime"
import { publishBackupChange } from "@/lib/backup-realtime.server"

// A full backup's copy in a bucket counts once Hearth has seen it there, at
// the size of the archive its Relay reported uploading and within its
// reservation: a Relay's word that it uploaded is not enough. Hearth looks
// in the background, never while it applies a report, woken when a pass
// over a Relay's backups ends and on the backup sweep, and settles each
// copy available or failed.

// How many copies Hearth looks for at once, and per look.
const LOOKS_AT_ONCE = 4
const COPIES_PER_LOOK = 100
// And of one destination per look, so a bucket that can't be asked never
// fills one.
const COPIES_PER_DESTINATION = 10
// Looks one check makes, one after another, while each settles something
// and leaves more waiting.
const LOOKS_PER_CHECK = 50
// A bucket that can't be asked is left alone a while, longer each time.
const FIRST_BACKOFF_MS = 30_000
const LONGEST_BACKOFF_MS = 10 * 60_000
// A copy Hearth still can't see by its deadline (`seen_by`, set by
// Hearth's clock when it first waits) fails, saying why, rather than wait
// for good: a final backup waits on it.

const backoff = new Map<string, { delayMs: number; until: number }>()
// Why the last look at a copy didn't settle it, for its failure at the
// deadline.
const lastAnswer = new Map<string, string>()

const unsettled = { seen: false, settled: false }

const failed = (code: string, reason: string) =>
  ({ code, kind: "failed", reason }) as const

// One look at a time, whoever asks: the sweep and a pass's request share
// what Hearth remembers of each bucket.
const oneLook = Semaphore.makeUnsafe(1)

/**
 * Looks in the bucket for each full backup copy waiting to be seen there,
 * and settles it: available at the size Hearth saw, or failed.
 */
export const checkBucketCopiesEffect = Effect.fn("BucketCopies.check")(
  function* () {
    yield* oneLook.withPermits(1)(
      Effect.gen(function* () {
        // Another bounded look follows at once while one settled something
        // and left more waiting, so a backlog of healthy copies is all seen
        // before its deadline; it stops once a look settles nothing, as
        // when only buckets left alone remain.
        for (let round = 0; round < LOOKS_PER_CHECK; round += 1) {
          const { more, settled } = yield* lookOnce
          if (!more || settled === 0) return
        }
      })
    )
  }
)

const lookOnce = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  const { copies: waiting, more } = yield* waitingBucketCopiesEffect({
    limit: COPIES_PER_LOOK,
    perDestination: COPIES_PER_DESTINATION,
    now,
    resting: [...backoff].flatMap(([storageId, { until }]) =>
      now < until ? [storageId] : []
    ),
  })
  return yield* Effect.forEach(
    waiting,
    (copy) =>
      Effect.gen(function* () {
        const settle = (
          outcome: Parameters<typeof settleBucketCopyEffect>[0]["outcome"]
        ) =>
          settleBucketCopyEffect({
            artifactId: copy.artifactId,
            backupId: copy.backupId,
            looked: { bytes: copy.reportedBytes, objectKey: copy.objectKey },
            outcome,
          }).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                lastAnswer.delete(copy.artifactId)
                if (settled) publishBackupChange(copy.relayId, copy.backupId)
              })
            ),
            Effect.map((settled) => ({
              seen: settled && outcome.kind === "seen",
              settled,
            }))
          )
        if (copy.late) {
          return yield* settle(
            failed(
              "bucket_copy_unseen",
              lastAnswer.get(copy.artifactId) ??
                "Hearth couldn't see this copy in the bucket within an hour of its upload"
            )
          )
        }
        const held = backoff.get(copy.storageId)
        if (!copy.objectKey || copy.reportedBytes === null) {
          return yield* settle(
            failed(
              "bucket_copy_unknown",
              "Hearth has no object or size to look for in the bucket"
            )
          )
        }
        const credential = yield* loadBackupStorageCredentialEffect(
          copy.storageId
        )
        if (!credential) {
          return yield* settle(
            failed("storage_unavailable", "Its backup destination is gone")
          )
        }
        const answer = yield* headS3BackupObject(
          credential,
          copy.objectKey
        ).pipe(
          Effect.map((found) => ({ found }) as const),
          Effect.catch((error) =>
            Effect.succeed({ error, status: s3StatusOf(error) } as const)
          )
        )
        if ("error" in answer) {
          // Not settled: looked for again once the bucket's backoff ends.
          const delayMs = Math.min(
            held ? held.delayMs * 2 : FIRST_BACKOFF_MS,
            LONGEST_BACKOFF_MS
          )
          backoff.set(copy.storageId, { delayMs, until: now + delayMs })
          lastAnswer.set(
            copy.artifactId,
            answer.status === 403
              ? "The bucket refused to let Hearth see this copy (403): it may be missing, or Hearth's key may not be allowed to read it"
              : "Hearth couldn't reach the bucket to see this copy"
          )
          return unsettled
        }
        backoff.delete(copy.storageId)
        const { found } = answer
        if (found.kind === "missing") {
          return yield* settle(
            failed("bucket_copy_missing", "This copy isn't in the bucket")
          )
        }
        if (found.bytes === null || found.bytes !== copy.reportedBytes) {
          return yield* settle(
            failed(
              "bucket_copy_mismatch",
              `The bucket holds ${found.bytes ?? "an unknown number of"} bytes for this copy; its Relay uploaded ${copy.reportedBytes}`
            )
          )
        }
        if (copy.maxBytes !== null && found.bytes > copy.maxBytes) {
          return yield* settle(
            failed(
              "bucket_copy_too_large",
              `This copy is ${found.bytes} bytes in the bucket, over its ${copy.maxBytes}-byte limit`
            )
          )
        }
        return yield* settle({ bytes: found.bytes, kind: "seen" })
      }).pipe(
        Effect.catch((cause) =>
          logException(cause, {
            operation: "BucketCopies.check",
            attributes: { "backup.id": copy.backupId },
          }).pipe(Effect.as(unsettled))
        )
      ),
    { concurrency: LOOKS_AT_ONCE }
  ).pipe(
    Effect.tap((looked) =>
      // A backup that now counts can take its target past its retention.
      looked.some(({ seen }) => seen)
        ? Effect.promise(() => import("@/lib/backup-maintenance.server")).pipe(
            Effect.map(({ requestBackupRetention }) => requestBackupRetention())
          )
        : Effect.void
    ),
    Effect.map((looked) => ({
      more,
      settled: looked.filter(({ settled }) => settled).length,
    }))
  )
})

// Asked for while a look runs, another follows it once.
let lookTimer: ReturnType<typeof setTimeout> | undefined
let looking = false
let lookAgain = false

/** Asks Hearth to look in the buckets for copies waiting to be seen. */
export function requestBucketCopyChecks(): void {
  if (lookTimer) return
  if (looking) {
    lookAgain = true
    return
  }
  lookTimer = setTimeout(() => {
    lookTimer = undefined
    looking = true
    void runAppEffect(
      "BucketCopies.check",
      checkBucketCopiesEffect().pipe(
        Effect.catch((cause) =>
          logException(cause, { operation: "BucketCopies.check" })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            looking = false
            if (lookAgain) {
              lookAgain = false
              requestBucketCopyChecks()
            }
          })
        )
      )
    )
  }, 1_000)
  lookTimer.unref()
}
