import { Clock, Effect, Semaphore } from "effect"
import { logException } from "@workspace/telemetry"

import {
  headS3BackupObject,
  loadBackupStorageCredentialEffect,
  s3StatusOf,
} from "@/backups/destinations/s3"
import {
  lateBucketCopiesEffect,
  noteBucketCopyEffect,
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
// or a refusal, leaves it to be looked for again a while after the look
// ends, longer each time: a bucket that can't be reached rests whole, while
// a refusal (403), which can be of one object, rests that copy alone. What
// Hearth heard of a copy, and when it may ask again, is kept with the copy
// (`noteBucketCopyEffect`), so a restart forgets none of it; a bucket's rest
// is only how hard Hearth asks, so it is kept here.
const BACKOFF = { firstMs: 30_000, longestMs: 10 * 60_000 }
// A copy still unseen by its deadline (`seen_by`, set by Hearth's clock when
// it first waits) fails, saying why, rather than wait for good: a final
// backup waits on it. One Hearth never got to look for first has one look.

type Rest = { delayMs: number; until: number }
const restingBuckets = new Map<string, Rest>()
const resting = (now: number) =>
  [...restingBuckets].flatMap(([id, { until }]) => (now < until ? [id] : []))
const restBucket = (id: string, now: number) => {
  const held = restingBuckets.get(id)
  const delayMs = Math.min(
    held ? held.delayMs * 2 : BACKOFF.firstMs,
    BACKOFF.longestMs
  )
  restingBuckets.set(id, { delayMs, until: now + delayMs })
}

// The report a look is for: settled only while it is still the copy's.
const lookedFor = (copy: {
  generation: number
  objectKey: string | null
  reportedBytes: number | null
}) => ({
  bytes: copy.reportedBytes,
  generation: copy.generation,
  objectKey: copy.objectKey,
})

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
  // Past their deadline and looked for before: failed with what the last
  // look heard, without asking any bucket again.
  for (const copy of yield* lateBucketCopiesEffect({
    limit: COPIES_PER_LOOK,
    now,
  })) {
    if (copy.heard === null) continue
    const settled = yield* settleBucketCopyEffect({
      artifactId: copy.artifactId,
      backupId: copy.backupId,
      looked: lookedFor(copy),
      outcome: failed("bucket_copy_unseen", copy.heard),
    })
    if (settled) publishBackupChange(copy.relayId, copy.backupId)
  }
  // One budget for every copy Hearth asks a bucket about, late ones it never
  // looked for among them.
  const { copies: waiting, more } = yield* waitingBucketCopiesEffect({
    limit: COPIES_PER_LOOK,
    now,
    perDestination: COPIES_PER_DESTINATION,
    resting: resting(now),
  })
  // What the look heard that didn't settle a copy, kept once it ends, so
  // each rest runs from then however long the look took.
  const unsettled: Array<{
    copy: (typeof waiting)[number]
    heard: string | null
    rests: "bucket" | "copy" | null
  }> = []
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
            looked: lookedFor(copy),
            outcome,
          }).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                if (settled) publishBackupChange(copy.relayId, copy.backupId)
              })
            ),
            Effect.map((settled) => ({
              seen: settled && outcome.kind === "seen",
            }))
          )
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
        ).pipe(
          Effect.map((loaded) => ({ loaded }) as const),
          Effect.catch((error) => Effect.succeed({ error } as const))
        )
        // Its destination's keys can't be read: the destination rests, and
        // the copy is looked for again once it may be.
        if ("error" in credential) {
          yield* logException(credential.error, {
            operation: "BucketCopies.credential",
            attributes: { "backup.storage.id": copy.storageId },
          })
          unsettled.push({
            copy,
            heard:
              "Hearth couldn't read this destination's keys to see the copy",
            rests: "bucket",
          })
          return { seen: false }
        }
        if (!credential.loaded) {
          return yield* settle(
            failed("storage_unavailable", "Its backup destination is gone")
          )
        }
        const answer = yield* headS3BackupObject(
          credential.loaded,
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
          if (copy.late)
            return yield* settle(failed("bucket_copy_unseen", said))
          unsettled.push({
            copy,
            heard: said,
            rests: answer.status === 403 ? "copy" : "bucket",
          })
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
        // Anything else that went wrong rests the copy, so the next look
        // reaches others rather than the same again.
        Effect.catch((cause) =>
          logException(cause, {
            operation: "BucketCopies.check",
            attributes: { "backup.id": copy.backupId },
          }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                unsettled.push({ copy, heard: null, rests: "copy" })
              })
            ),
            Effect.as({ seen: false })
          )
        )
      ),
    { concurrency: LOOKS_AT_ONCE }
  )
  const ended = yield* Clock.currentTimeMillis
  for (const { copy, heard, rests } of unsettled) {
    if (rests === "bucket") restBucket(copy.storageId, ended)
    yield* noteBucketCopyEffect({
      artifactId: copy.artifactId,
      at: ended,
      generation: copy.generation,
      heard,
      rest: rests === "copy" ? BACKOFF : null,
    }).pipe(
      Effect.catch((cause) =>
        logException(cause, {
          operation: "BucketCopies.note",
          attributes: { "backup.id": copy.backupId },
        })
      )
    )
  }
  // A backup that now counts can take its target past its retention.
  if (looked.some(({ seen }) => seen)) {
    const { requestBackupRetention } = yield* Effect.promise(
      () => import("@/lib/backup-maintenance.server")
    )
    requestBackupRetention()
  }
  // Another look could reach copies this one left: there were more than it
  // took, and it looked at some, each of which it settled or left resting,
  // so the next look reaches others.
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
