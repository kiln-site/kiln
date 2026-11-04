import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  loadGitHubSyncEffect,
  recordGitHubSyncAttemptEffect,
  updateGitHubSyncEffect,
} from "@/effect/github-sync"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const syncId = "11111111-1111-4111-8111-111111111111"
const connectionId = "22222222-2222-4222-8222-222222222222"
const commitSha = "a".repeat(40)

const settings = {
  autoSync: true,
  branch: "main",
  includePatterns: ["*.json", "*.yaml"],
  overwrite: false,
  repository: "kiln/configs",
  repositoryId: 1,
  sourcePath: "",
  targetPath: "",
}

// A sync as Hearth stores one: its patterns are the text of `JSON.stringify`.
const seedSync = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay("relay-one")
  yield* insertRows("github_connection", {
    id: connectionId,
    owner_user_id: "owner",
    app_id: 1,
    app_slug: "kiln",
    app_name: "Kiln",
    app_url: "https://github.test/apps/kiln",
    app_owner_login: "kiln",
    client_id: "client",
    credentials_ciphertext: "credentials",
    created_at: 0,
    updated_at: 0,
  })
  yield* insertRows("github_sync", {
    id: syncId,
    connection_id: connectionId,
    relay_id: "relay-one",
    resource_kind: "instance",
    resource_id: "instance-one",
    repository_id: settings.repositoryId,
    repository: settings.repository,
    branch: settings.branch,
    include_patterns: JSON.stringify(settings.includePatterns),
    last_commit_sha: commitSha,
    synced_files: "{}",
    created_by: "owner",
    created_at: 0,
    updated_at: 0,
  })
})

const shaAfterSaving = (includePatterns: Array<string>, branch = "main") =>
  Effect.gen(function* () {
    yield* seedSync
    yield* updateGitHubSyncEffect(syncId, {
      ...settings,
      branch,
      includePatterns,
    })
    return (yield* loadGitHubSyncEffect(syncId)).lastCommitSha
  })

describeMysql("GitHub syncs", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps the last commit when a save changes no source", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* shaAfterSaving(settings.includePatterns),
          commitSha
        )
      })
    )

    it.effect("forgets the last commit when a save changes the source", () =>
      Effect.gen(function* () {
        assert.isNull(yield* shaAfterSaving(["*.json"]))
        assert.isNull(yield* shaAfterSaving(["*.yaml", "*.json"]))
        assert.isNull(yield* shaAfterSaving(["*.JSON", "*.yaml"]))
        assert.isNull(yield* shaAfterSaving(settings.includePatterns, "next"))
      })
    )

    it.effect("records a file attempted at any path, as JSON", () =>
      Effect.gen(function* () {
        yield* seedSync
        const path = 'configs/a.b "c".json'
        const file = { blob: "b".repeat(40), modifiedAt: 1 }
        yield* recordGitHubSyncAttemptEffect(syncId, path, file)
        const sync = yield* loadGitHubSyncEffect(syncId)
        assert.deepStrictEqual(sync.syncedFiles, { [path]: file })
        assert.isNull(sync.lastCommitSha)
      })
    )
  })
})
