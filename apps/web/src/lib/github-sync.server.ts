import { posix } from "node:path"

import {
  appFileRootId,
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
  type GitHubSyncTrigger,
  setGitHubSyncStatusEffect,
} from "@/effect/github-sync"
import { forkPromise } from "@/effect/promise"
import { forkAppWorker, runAppEffect } from "@/effect/runtime"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"

// A put carries the file in one control frame, which caps its size.
const maxSyncedFileBytes = 512 * 1024
const maxSyncedFiles = 2_000
const pollInterval = "1 minute"

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
  if (trigger === "poll" && head.sha === sync.lastCommitSha) return

  yield* setGitHubSyncStatusEffect(sync.id, "running")
  publishGitHubSyncChange()

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

  const fileRootId =
    sync.resourceKind === "app"
      ? appFileRootId(sync.resourceId)
      : sync.resourceId
  const syncedFiles = { ...sync.syncedFiles }
  let changed = 0
  let skipped = 0
  let kept = 0
  for (const file of files) {
    const previous = syncedFiles[file.target]
    if (previous?.blob === file.sha) continue
    if (file.size > maxSyncedFileBytes) {
      skipped += 1
      continue
    }
    const written = yield* getGitHubBlobEffect(
      token,
      sync.repository,
      file.sha
    ).pipe(
      Effect.flatMap((content) =>
        Effect.tryPromise({
          try: () =>
            relayRpc(
              relay,
              "instance.files.put",
              {
                contentBase64: content.toString("base64"),
                instanceId: fileRootId,
                path: file.target,
                // Without overwrite, only a file Kiln left as it was, or
                // none, is written; anything else is someone's edit.
                ...(sync.overwrite
                  ? {}
                  : { unlessModifiedSince: previous?.modifiedAt ?? null }),
              },
              30_000,
              sync.createdBy
            ),
          catch: (cause) =>
            new Error(
              `Couldn't write ${file.target}: ${syncFailureMessage(cause)}`
            ),
        })
      ),
      Effect.map((result) => relayFilePutResultSchema.parse(result)),
      Effect.result
    )
    if (written._tag === "Failure") {
      return yield* recordGitHubSyncResultEffect(sync.id, run, {
        error: syncFailureMessage(written.failure),
        syncedFiles,
      }).pipe(Effect.andThen(Effect.sync(publishGitHubSyncChange)))
    }
    if (written.success.conflict) {
      kept += 1
      continue
    }
    syncedFiles[file.target] = {
      blob: file.sha,
      modifiedAt: Date.parse(written.success.modifiedAt),
    }
    changed += 1
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
  var kilnGitHubSyncWaiting: Set<string> | undefined
  var kilnGitHubSyncPoller: Fiber.Fiber<void> | undefined
}

const syncLocks = (globalThis.kilnGitHubSyncLocks ??= new Map())
const waiting = (globalThis.kilnGitHubSyncWaiting ??= new Set())

/**
 * Runs a sync in the background, one at a time per sync. A trigger arriving
 * while another waits joins it: the waiting run reads the newest commit.
 */
export function enqueueGitHubSync(
  syncId: string,
  trigger: GitHubSyncTrigger
): void {
  if (waiting.has(syncId)) return
  waiting.add(syncId)
  let lock = syncLocks.get(syncId)
  if (!lock) {
    lock = Semaphore.makeUnsafe(1)
    syncLocks.set(syncId, lock)
  }
  if (trigger !== "poll") {
    forkPromise(() =>
      runAppEffect(
        "github.sync.queue",
        setGitHubSyncStatusEffect(syncId, "queued")
      ).then(publishGitHubSyncChange)
    )
  }
  forkAppWorker(
    lock.withPermit(
      Effect.sync(() => waiting.delete(syncId)).pipe(
        Effect.andThen(runGitHubSyncEffect(syncId, trigger)),
        Effect.catchCause((cause) =>
          // A failing poll fails again every minute; the sync's status
          // shows it, so only the first report reaches telemetry.
          (trigger === "poll"
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
                { startedAt: now, trigger },
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
