import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { loadConfig } from "../config.js"
import { loadOrCreateRelayIdentity, renameRelayIdentity } from "./identity.js"

describe("Relay identity", () => {
  it.live("persists renames and ignores later environment seeds", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_NAME: "Relay Alpha",
          NODE_ENV: "development",
        })
        const initial = yield* loadOrCreateRelayIdentity(config)
        const renamed = yield* renameRelayIdentity(
          config,
          initial,
          "Legacy Relay Name"
        )
        const restarted = yield* loadOrCreateRelayIdentity(
          loadConfig({
            KILN_RELAY_DATA_DIR: directory,
            KILN_RELAY_NAME: "Replacement Name",
            NODE_ENV: "development",
          })
        )

        assert.strictEqual(initial.fingerprint, restarted.fingerprint)
        assert.strictEqual(renamed.name, "Legacy Relay Name")
        assert.strictEqual(restarted.name, "Legacy Relay Name")
        assert.strictEqual(initial.privateKeyPem, restarted.privateKeyPem)

        const privateKeyPath = join(
          directory,
          "network",
          "identity",
          "identity.key"
        )
        assert.strictEqual(
          (yield* fromPromise(() => stat(privateKeyPath))).mode & 0o777,
          0o600
        )
        assert.include(
          yield* fromPromise(() => readFile(privateKeyPath, "utf8")),
          "BEGIN PRIVATE KEY"
        )
      })
    )
  )
})

function withTemporaryDirectory<T>(
  use: (directory: string) => Effect.Effect<T, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(join(tmpdir(), "kiln-relay-identity-"))),
    use,
    (directory) =>
      fromPromise(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.orDie
      )
  )
}

function fromPromise<T>(run: () => Promise<T>) {
  return Effect.tryPromise(run)
}
