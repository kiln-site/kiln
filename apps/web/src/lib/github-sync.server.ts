import { posix } from "node:path"

import {
  relayFilePutResultSchema,
  relayFilePutV1Feature,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import {
  Cause,
  Clock,
  Effect,
  Fiber,
  Predicate,
  Schedule,
  Semaphore,
} from "effect"

import {
  getGitHubBlobEffect,
  getGitHubBranchHeadEffect,
  getGitHubTreeEffect,
  githubInstallationTokenEffect,
} from "@/effect/github-api"
import {
  loadGitHubConnectionCredentialEffect,
  loadGitHubSyncEffect,
  loadPolledGitHubSyncsEffect,
  recordGitHubSyncResultEffect,
  restoreGitHubSyncEffect,
  recordGitHubSyncAttemptEffect,
  type GitHubSyncTrigger,
  setGitHubSyncStatusEffect,
} from "@/effect/github-sync"
import type { Database } from "@/effect/database"
import { forkAppWorker } from "@/effect/runtime"
import { githubSyncTargetAccess } from "@/lib/github-sync-targets"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"

// A put carries the file in one control frame, which caps its size.
const maxSyncedFileBytes = 512 * 1024
const maxSyncedFiles = 2_000
const pollInterval = "1 minute"
// Unconfirmed writes remembered per file. Only attempted writes count, and
// the newest landed one is on disk, so this many lost replies in a row on
// one file would have to pass before it's forgotten.
const maxPendingWrites = 20

export function publishGitHubSyncChange(): void {
  publishRealtimeChange({
    audience: { kind: "authenticated" },
    topics: ["github-sync"],
    type: "hearth.invalidate",
  })
}

/** Whether a repository path, relative to the sync's folder, is included. */
function githubSyncIncludes(
  patterns: ReadonlyArray<string>,
  relativePath: string
): boolean {
  if (patterns.length === 0) return true
  const name = posix.basename(relativePath)
  return patterns.some((pattern) =>
    // As in .gitignore, a pattern without a slash matches at any depth.
    pattern.includes("/")
      ? posix.matchesGlob(relativePath, pattern.replace(/^\/+/u, ""))
      : posix.matchesGlob(name, pattern)
  )
}

/**
 * Copies the files a sync covers from the head of its branch into its
 * instance. Files Kiln already wrote at the same blob are skipped, so a sync
 * only writes what changed; files removed from the repository stay. Unless
 * the sync overwrites, files that existed first or changed since Kiln wrote
 * them are kept.
 */
const runGitHubSyncEffect = Effect.fn("github.sync.run")(function* (
  syncId: string,
  trigger: GitHubSyncTrigger
) {
  const run = { startedAt: yield* Clock.currentTimeMillis, trigger }
  const sync = yield* loadGitHubSyncEffect(syncId)
  const connection = yield* loadGitHubConnectionCredentialEffect({
    id: sync.connectionId,
  })
  yield* Effect.annotateCurrentSpan({
    "github.repository": sync.repository,
    "github.sync.id": sync.id,
    "github.sync.trigger": trigger,
    "relay.id": sync.relayId,
  })
  const fail = (message: string) =>
    recordGitHubSyncResultEffect(sync.id, run, { error: message }).pipe(
      Effect.tap((changed) =>
        Effect.sync(() => {
          if (changed) publishGitHubSyncChange()
        })
      )
    )
  const installation = connection.installation
  if (!installation || installation.suspended) {
    return yield* fail(
      installation
        ? `The GitHub App is suspended on ${installation.accountLogin}`
        : "Install the GitHub App before syncing"
    )
  }
  const relays = yield* listPersistedRelaysEffect()
  const relay = relays.find((item) => item.enabled && item.id === sync.relayId)
  if (!relay) return yield* fail("The Relay is no longer available")
  const features = relayConnectionFeatures(relay.id)
  if (features.size === 0) return yield* fail("The Relay is offline")
  if (!features.has(relayFilePutV1Feature)) {
    return yield* fail("Update this Relay to sync files from GitHub")
  }

  const credentials = {
    appId: connection.appId,
    privateKey: connection.privateKey,
  }
  const token = yield* githubInstallationTokenEffect(
    credentials,
    installation.id
  )
  const head = yield* getGitHubBranchHeadEffect(
    token,
    sync.repository,
    sync.branch
  )
  // Polls only look for new commits. Other triggers compare every file
  // with the blob Kiln last wrote, so they finish a sync that failed partway.
  if (trigger === "poll" && head.sha === sync.lastCommitSha) {
    // The files are still at the commit Kiln synced, so a failure since,
    // such as an offline Relay, has passed.
    if (sync.status === "error") {
      yield* restoreGitHubSyncEffect(sync.id)
      publishGitHubSyncChange()
    }
    return
  }

  // Polls stay quiet: a sync that keeps failing then keeps its status, and
  // the same failure isn't recorded again.
  if (trigger !== "poll") {
    yield* setGitHubSyncStatusEffect(sync.id, "running")
    publishGitHubSyncChange()
  }

  const tree = yield* getGitHubTreeEffect(token, sync.repository, head.sha)
  if (tree.truncated) {
    return yield* fail(
      "This repository has too many files to read at once; choose a smaller folder"
    )
  }
  const prefix = sync.sourcePath ? `${sync.sourcePath}/` : ""
  const files = tree.tree.flatMap((entry) => {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) return []
    const relativePath = entry.path.slice(prefix.length)
    if (!githubSyncIncludes(sync.includePatterns, relativePath)) return []
    return [
      {
        sha: entry.sha,
        size: entry.size ?? 0,
        source: entry.path,
        target: sync.targetPath
          ? `${sync.targetPath}/${relativePath}`
          : relativePath,
      },
    ]
  })
  if (files.length > maxSyncedFiles) {
    return yield* fail(
      `This folder has ${files.length} files; sync at most ${maxSyncedFiles} by choosing a folder or patterns`
    )
  }

  const access = githubSyncTargetAccess({
    id: sync.resourceId,
    kind: sync.resourceKind === "instance" ? "server" : sync.resourceKind,
    relayId: sync.relayId,
  })
  if (!access) return yield* fail("This sync's instance doesn't exist")
  const fileRootId = access.fileRootId
  const recorded = sync.syncedFiles
  const syncedFiles = { ...recorded }
  let changed = 0
  let skipped = 0
  let kept = 0
  const toWrite = files.filter((file) => {
    const entry = recorded[file.target]
    // An unconfirmed write may have replaced the recorded blob, so the file
    // is checked again even when GitHub's copy matches it.
    if (entry?.blob === file.sha && !entry.pending?.length) return false
    if (file.size > maxSyncedFileBytes) {
      skipped += 1
      return false
    }
    return true
  })

  const putFile = (
    target: string,
    content: Buffer,
    unlessModifiedSince: number | null | undefined
  ) =>
    Effect.tryPromise({
      try: () =>
        relayRpc(
          relay,
          "instance.files.put",
          {
            contentBase64: content.toString("base64"),
            instanceId: fileRootId,
            path: target,
            ...(unlessModifiedSince === undefined
              ? {}
              : { unlessModifiedSince }),
          },
          30_000,
          sync.createdBy
        ),
      catch: (cause) =>
        new Error(`Couldn't write ${target}: ${syncFailureMessage(cause)}`),
    }).pipe(Effect.map((result) => relayFilePutResultSchema.parse(result)))

  for (const file of toWrite) {
    const previous = recorded[file.target]
    // Recorded just before it's attempted, so a write that lands with its
    // reply lost is still recognized as Kiln's on a later run. Only writes
    // actually attempted are kept, until one is confirmed.
    const attempt = {
      blob: previous?.blob ?? null,
      modifiedAt: previous?.modifiedAt ?? null,
      pending: [...new Set([...(previous?.pending ?? []), file.sha])].slice(
        -maxPendingWrites
      ),
    }
    syncedFiles[file.target] = attempt
    yield* recordGitHubSyncAttemptEffect(sync.id, file.target, attempt)
    const written = yield* getGitHubBlobEffect(
      token,
      sync.repository,
      file.sha
    ).pipe(
      Effect.flatMap((content) =>
        // Without overwrite, only a file Kiln left as it was, or none, is
        // written; anything else is someone's edit.
        putFile(
          file.target,
          content,
          sync.overwrite ? undefined : (previous?.modifiedAt ?? null)
        ).pipe(
          Effect.flatMap((result) => {
            if (!result.conflict) return Effect.succeed(result)
            const current = result.current?.blob
            // Content Kiln wrote, or tried to write, is still Kiln's file,
            // however its time changed: replace it as it now stands.
            const ours =
              current !== undefined &&
              current !== null &&
              current !== file.sha &&
              (current === attempt.blob || attempt.pending.includes(current))
            return ours
              ? putFile(file.target, content, result.current!.modifiedAt)
              : Effect.succeed(result)
          })
        )
      ),
      Effect.result
    )
    if (written._tag === "Failure") {
      // The records, pending writes included, outlast the failure; the
      // instance may no longer be at the last synced commit.
      return yield* recordGitHubSyncResultEffect(sync.id, run, {
        error: syncFailureMessage(written.failure),
        syncedFiles,
      }).pipe(
        Effect.tap((recordedResult) =>
          Effect.sync(() => {
            if (recordedResult) publishGitHubSyncChange()
          })
        )
      )
    }
    const result = written.success
    if (!result.conflict) {
      syncedFiles[file.target] = {
        blob: file.sha,
        modifiedAt: Date.parse(result.modifiedAt),
      }
      changed += 1
    } else if (result.current?.blob === file.sha) {
      // Already the repository's content, as when Kiln's earlier write
      // landed but its reply was lost.
      syncedFiles[file.target] = {
        blob: file.sha,
        modifiedAt: result.current.modifiedAt,
      }
    } else {
      kept += 1
      if (previous) syncedFiles[file.target] = previous
      else delete syncedFiles[file.target]
    }
  }

  const warnings: Array<string> = []
  if (skipped > 0) {
    warnings.push(
      `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} over 512 KB`
    )
  }
  if (kept > 0) {
    warnings.push(
      `Kept ${kept} ${kept === 1 ? "file" : "files"} that already existed or changed on the instance`
    )
  }

  yield* recordGitHubSyncResultEffect(sync.id, run, {
    changedCount: changed,
    commitMessage: head.message,
    commitSha: head.sha,
    syncedFiles,
    warning: warnings.length > 0 ? warnings.join(". ") : null,
  })
  publishGitHubSyncChange()
})

declare global {
  var kilnGitHubSyncLocks: Map<string, Semaphore.Semaphore> | undefined
  var kilnGitHubSyncQueued: Map<string, GitHubSyncTrigger> | undefined
  var kilnGitHubSyncPoller: Fiber.Fiber<void> | undefined
}

const syncLocks = (globalThis.kilnGitHubSyncLocks ??= new Map())
// The trigger of each sync's waiting run.
const waiting = (globalThis.kilnGitHubSyncQueued ??= new Map())

/**
 * Runs a sync in the background, one at a time per sync. A trigger arriving
 * while another waits joins it: the waiting run reads the newest commit and
 * settings, and takes the stronger trigger, so a poll can't swallow a manual
 * run or an edit.
 */
export function enqueueGitHubSync(
  syncId: string,
  trigger: GitHubSyncTrigger
): void {
  const queued = waiting.get(syncId)
  if (queued !== undefined) {
    // The waiting run shows its own status once it starts.
    if (queued === "poll" && trigger !== "poll") waiting.set(syncId, trigger)
    return
  }
  waiting.set(syncId, trigger)
  const lock = syncLocks.get(syncId) ?? Semaphore.makeUnsafe(1)
  syncLocks.set(syncId, lock)
  // Marked queued in the same fiber, before its run, so a slow update can't
  // land after the run and leave the sync looking queued.
  const markQueued: Effect.Effect<void, never, Database> =
    trigger === "poll"
      ? Effect.void
      : setGitHubSyncStatusEffect(syncId, "queued").pipe(
          Effect.andThen(Effect.sync(publishGitHubSyncChange)),
          Effect.ignore
        )
  const run = lock.withPermit(
    Effect.sync(() => {
      const next = waiting.get(syncId) ?? trigger
      waiting.delete(syncId)
      return next
    }).pipe(
      Effect.flatMap((next) =>
        runGitHubSyncEffect(syncId, next).pipe(
          Effect.catchCause((cause) =>
            // A failing poll fails again every minute; the sync's status
            // shows it, so only the first report reaches telemetry.
            (next === "poll"
              ? Effect.void
              : logException(Cause.squash(cause), {
                  operation: "github.sync.run",
                  attributes: { "github.sync.id": syncId },
                })
            ).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.flatMap((now) =>
                recordGitHubSyncResultEffect(
                  syncId,
                  { startedAt: now, trigger: next },
                  { error: syncFailureMessage(Cause.squash(cause)) }
                ).pipe(
                  Effect.tap((changed) =>
                    Effect.sync(() => {
                      if (changed) publishGitHubSyncChange()
                    })
                  ),
                  Effect.ignore
                )
              )
            )
          )
        )
      )
    )
  )
  forkAppWorker(Effect.andThen(markQueued, run))
}

/**
 * Connections created where GitHub can't reach Hearth get no webhooks, so
 * their auto syncs check for a new commit every minute instead.
 */
export function startGitHubSyncPolling(): void {
  globalThis.kilnGitHubSyncPoller ??= forkAppWorker(
    loadPolledGitHubSyncsEffect().pipe(
      Effect.tap((syncs) =>
        Effect.sync(() => {
          for (const sync of syncs) enqueueGitHubSync(sync.id, "poll")
        })
      ),
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), { operation: "github.sync.poll" })
      ),
      Effect.repeat(Schedule.spaced(pollInterval)),
      Effect.asVoid
    )
  )
}

export function stopGitHubSyncPolling(): Promise<void> {
  const poller = globalThis.kilnGitHubSyncPoller
  globalThis.kilnGitHubSyncPoller = undefined
  return poller ? Effect.runPromise(Fiber.interrupt(poller)) : Promise.resolve()
}

if (import.meta.hot) import.meta.hot.dispose(() => stopGitHubSyncPolling())

function syncFailureMessage(cause: unknown): string {
  return Predicate.hasProperty(cause, "message") &&
    Predicate.isString(cause.message) &&
    cause.message
    ? cause.message
    : "The sync failed"
}
