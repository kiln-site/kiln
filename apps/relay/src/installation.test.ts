import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  adoptInstallationId,
  InstallationReplaceError,
  loadInstallationId,
  replaceInstallationId,
} from "./installation.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"

describe("a Relay's installation ID", () => {
  it.effect("is adopted from a Hearth only while the Relay has none", () =>
    withInstallation((installation) =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        yield* adoptInstallationId(installation, state, "first-kiln")
        // Another Hearth sharing the Relay doesn't take it over.
        yield* adoptInstallationId(installation, state, "second-kiln")
        assert.strictEqual(installation.installationId, "first-kiln")

        const restarted = { ...installation, installationId: null }
        yield* loadInstallationId(restarted, state)
        assert.strictEqual(restarted.installationId, "first-kiln")
      })
    )
  )

  it.effect("is replaced only from what it's expected to be, once", () =>
    withInstallation((installation) =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        yield* adoptInstallationId(installation, state, "first-kiln")

        const stale = yield* Effect.flip(
          replaceInstallationId(installation, state, {
            expectedInstallationId: "someone-else",
            installationId: "second-kiln",
          })
        )
        assert.strictEqual(replaceCode(stale), "installation_changed")
        assert.strictEqual(installation.installationId, "first-kiln")

        const replace = replaceInstallationId(installation, state, {
          expectedInstallationId: "first-kiln",
          installationId: "second-kiln",
        })
        assert.deepStrictEqual(yield* replace, {
          installationId: "second-kiln",
        })
        // Asked again once it's applied, as after a lost answer.
        assert.deepStrictEqual(yield* replace, {
          installationId: "second-kiln",
        })

        const restarted = { ...installation, installationId: null }
        yield* loadInstallationId(restarted, state)
        assert.strictEqual(restarted.installationId, "second-kiln")
      })
    )
  )
})

function replaceCode(error: { readonly _tag: string }): string {
  return error instanceof InstallationReplaceError ? error.code : error._tag
}

function withInstallation<A, E>(
  use: (installation: {
    dataDirectory: string
    installationId: string | null
    installationIdConfigured: boolean
    provenHearth: null
  }) => Effect.Effect<A, E, RelayStateStore>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-relay-installation-"))),
    (directory) =>
      use({
        dataDirectory: directory,
        installationId: null,
        installationIdConfigured: false,
        provenHearth: null,
      }).pipe(
        Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
      ),
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}
