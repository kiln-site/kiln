import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { loadConfig } from "../config.js"
import { loadRelayTls } from "./tls.js"

describe("Relay managed TLS", () => {
  it.live("persists its CA and renews its leaf certificate", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const now = Date.UTC(2026, 0, 1)
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          KILN_RELAY_TLS_MODE: "managed",
          NODE_ENV: "production",
        })
        const initial = yield* loadRelayTls(config, now)
        assert.isNotNull(initial)
        if (!initial) return

        const restarted = yield* loadRelayTls(
          config,
          now + 24 * 60 * 60 * 1_000
        )
        assert.isNotNull(restarted)
        if (!restarted) return
        assert.strictEqual(initial.fingerprint, restarted.fingerprint)

        const caPath = join(directory, "network", "tls", "ca.crt")
        const caBeforeRenewal = yield* fromPromise(() =>
          readFile(caPath, "utf8")
        )
        const renewed = yield* loadRelayTls(
          config,
          now + 61 * 24 * 60 * 60 * 1_000
        )
        assert.isNotNull(renewed)
        if (!renewed) return
        assert.notStrictEqual(initial.fingerprint, renewed.fingerprint)
        assert.strictEqual(
          caBeforeRenewal,
          yield* fromPromise(() => readFile(caPath, "utf8"))
        )
        assert.strictEqual(
          (yield* fromPromise(() =>
            stat(join(directory, "network", "tls", "relay.key"))
          )).mode & 0o777,
          0o600
        )

        yield* fromPromise(() =>
          Promise.all([
            rm(join(directory, "network", "tls", "ca.crt")),
            rm(join(directory, "network", "tls", "ca.key")),
          ])
        )
        const recovered = yield* loadRelayTls(
          config,
          now + 62 * 24 * 60 * 60 * 1_000
        )
        assert.isNotNull(recovered)
        if (!recovered) return
        assert.notStrictEqual(recovered.fingerprint, renewed.fingerprint)
        assert.notStrictEqual(
          caBeforeRenewal,
          yield* fromPromise(() => readFile(caPath, "utf8"))
        )
      })
    )
  )
})

function withTemporaryDirectory<T>(
  use: (directory: string) => Effect.Effect<T, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(join(tmpdir(), "kiln-relay-tls-"))),
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
