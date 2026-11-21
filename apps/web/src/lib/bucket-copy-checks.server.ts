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
import { forkAppEffect } from "@/effect/runtime"
import { publishBackupChange } from "@/lib/backup-realtime.server"

// A full backup's copy in a bucket counts once Hearth has seen it there, at
// the size of the archive its Relay reported uploading and within its
// reservation: a Relay's word that it uploaded is not enough. Hearth looks
// in the background, never while it applies a report: one bounded look per
// wake, woken when a pass over a Relay's backups ends and by the backup
// sweep, and another soon after while copies remain that a look could
// reach. Each copy is settled available or failed.

// How many copies Hearth looks for at once, per look, and of one
// destination per look, so a bucket that can't be asked never fills one.
const LOOKS_AT_ONCE = 4
const COPIES_PER_LOOK = 100
const COPIES_PER_DESTINATION = 10
// How soon another look follows one that left copies it could reach.
const NEXT_LOOK_MS = 1_000
// An answer that says nothing of the copy, as a bucket that can't be reached
// or a refusal, leaves it to be looked for again a while later, longer each
// time: a bucket that can't be reached rests whole, while a refusal (403),
// which can be of one object, rests that copy alone.
const FIRST_BACKOFF_MS = 30_000
const LONGEST_BACKOFF_MS = 10 * 60_000
// A copy still unseen by its deadline (`seen_by`, set by Hearth's clock when
// it first waits) fails, saying why, rather than wait for good: a final
// backup waits on it. One Hearth never got to look for first has one look.

type Rest = { delayMs: number; until: number }
const restingBuckets = new Map<string, Rest>()
const restingCopies = new Map<string, Rest>()
// Why the last look at a copy didn't settle it, for its failure at the
// deadline; a copy here has been looked for.
const lastAnswer = new Map<string, string>()

const resting = (rests: Map<string, Rest>, now: number) =>
  [...rests].flatMap(([id, { until }]) => (now < until ? [id] : []))
const rest = (rests: Map<string, Rest>, id: string, now: number) => {
  const held = rests.get(id)
  const delayMs = Math.min(
    held ? held.delayMs * 2 : FIRST_BACKOFF_MS,
    LONGEST_BACKOFF_MS
  )
  rests.set(id, { delayMs, until: now + delayMs })
}

const failed = (code: string, reason: string) =>
  ({ code, kind: "failed", reason }) as const

// One look at a time, whoever asks, so looks share what Hearth remembers
// of each bucket and copy.
const oneLook = Semaphore.makeUnsafe(1)

/**
 * Makes one bounded look in the buckets for full backup copies waiting to
 * be seen there, settling each it can: available at the size Hearth saw, or
 * failed. Answers whether another look could reach copies this one left.
 */
export const checkBucketCopiesEffect = Effect.fn("BucketCopies.check")(
  function* () {
    return yield* oneLook.withPermits(1)(lookOnce)
  }
)

const lookOnce = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  const { copies: waiting, more } = yield* waitingBucketCopiesEffect({
    limit: COPIES_PER_LOOK,
    now,
    perDestination: COPIES_PER_DESTINATION,
    resting: resting(restingBuckets, now),
    restingCopies: resting(restingCopies, now),
  })
  const looked = yield* Effect.forEach(
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
                restingCopies.delete(copy.artifactId)
                if (settled) publishBackupChange(copy.relayId, copy.backupId)
              })
            ),
            Effect.map((settled) => ({
              seen: settled && outcome.kind === "seen",
            }))
          )
        // Past its deadline, and looked for before: it fails with what the
        // last look heard.
        const heard = lastAnswer.get(copy.artifactId)
        if (copy.late && heard !== undefined) {
          return yield* settle(failed("bucket_copy_unseen", heard))
        }
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
          const said =
            answer.status === 403
              ? "The bucket refused to let Hearth see this copy (403): it may be missing, or Hearth's key may not be allowed to read it"
              : "Hearth couldn't reach the bucket to see this copy"
          // Its one look past the deadline told it nothing more.
          if (copy.late) return yield* settle(failed("bucket_copy_unseen", said))
          lastAnswer.set(copy.artifactId, said)
          if (answer.status === 403) {
            rest(restingCopies, copy.artifactId, now)
          } else {
            rest(restingBuckets, copy.storageId, now)
          }
          return { seen: false }
        }
        restingBuckets.delete(copy.storageId)
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
          }).pipe(Effect.as({ seen: false }))
        )
      ),
    { concurrency: LOOKS_AT_ONCE }
  )
  // A backup that now counts can take its target past its retention.
  if (looked.some(({ seen }) => seen)) {
    const { requestBackupRetention } = yield* Effect.promise(
      () => import("@/lib/backup-maintenance.server")
    )
    requestBackupRetention()
  }
  // Another look could reach copies this one left: there were more than it
  // took, and it looked at some, so it isn't stuck on copies left resting.
  return { more: more && waiting.length > 0 }
})

// One look at a time: asked for while one runs, another follows it once,
// and one that left copies another could reach asks for the next itself.
let lookTimer: ReturnType<typeof setTimeout> | undefined
let looking = false
let lookAgain = false

/**
 * Asks Hearth to look in the buckets for copies waiting to be seen. Doesn't
 * wait for the look: reports and the sweep only wake it.
 */
export function requestBucketCopyChecks(after = NEXT_LOOK_MS): void {
  if (lookTimer) return
  if (looking) {
    lookAgain = true
    return
  }
  lookTimer = setTimeout(() => {
    lookTimer = undefined
    looking = true
    // A fiber of its own: stopped with the app, as on shutdown, it leaves
    // no promise to reject.
    forkAppEffect(
      "BucketCopies.check",
      checkBucketCopiesEffect().pipe(
        Effect.tap(({ more }) =>
          Effect.sync(() => {
            if (more) lookAgain = true
          })
        ),
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
  }, after)
  lookTimer.unref()
}
