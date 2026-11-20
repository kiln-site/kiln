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

  it.effect("takes a restored Kiln's new ID in place of the one it had", () =>
    withInstallation((installation) =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        yield* adoptInstallationId(installation, state, "kiln-lost")
        // A Hearth that doesn't list the Relay's ID doesn't take it over.
        yield* adoptInstallationId(installation, state, "other-kiln", [
          "someone-else",
        ])
        assert.strictEqual(installation.installationId, "kiln-lost")

        yield* adoptInstallationId(installation, state, "kiln-restored", [
          "kiln-lost",
        ])
        // Nor does the lost machine's Hearth, if it runs again.
        yield* adoptInstallationId(installation, state, "kiln-lost")
        assert.strictEqual(installation.installationId, "kiln-restored")

        const restarted = {
          ...installation,
          installationId: null,
          previousInstallationIds: [],
        }
        yield* loadInstallationId(restarted, state)
        assert.strictEqual(restarted.installationId, "kiln-restored")
        assert.deepStrictEqual(restarted.previousInstallationIds, ["kiln-lost"])

        // Handed over again, then given back to an ID in its history by a
        // person, it keeps none of that history.
        yield* adoptInstallationId(restarted, state, "kiln-again", [
          "kiln-lost",
          "kiln-restored",
        ])
        assert.deepStrictEqual(restarted.previousInstallationIds, [
          "kiln-lost",
          "kiln-restored",
        ])
        // A transfer back that fails part way through saving changes
        // neither the ID nor its history.
        const interrupted = yield* Effect.flip(
          state.setMetadataEntries({
            installation_id: "kiln-restored",
            previous_installation_ids: null as unknown as string,
          })
        )
        assert.ok(interrupted)
        const afterFailure = {
          ...restarted,
          installationId: null,
          previousInstallationIds: [],
        }
        yield* loadInstallationId(afterFailure, state)
        assert.strictEqual(afterFailure.installationId, "kiln-again")
        assert.deepStrictEqual(afterFailure.previousInstallationIds, [
          "kiln-lost",
          "kiln-restored",
        ])

        yield* replaceInstallationId(restarted, state, {
          expectedInstallationId: "kiln-again",
          installationId: "kiln-restored",
        })
        const givenBack = {
          ...restarted,
          installationId: null,
          previousInstallationIds: [],
        }
        yield* loadInstallationId(givenBack, state)
        assert.strictEqual(givenBack.installationId, "kiln-restored")
        assert.deepStrictEqual(givenBack.previousInstallationIds, [])

        // Set to another installation in its environment, it keeps none of
        // the restored one's history either.
        const configured = {
          ...installation,
          installationId: "kiln-configured",
          installationIdConfigured: true,
          previousInstallationIds: [],
        }
        yield* loadInstallationId(configured, state)
        assert.deepStrictEqual(configured.previousInstallationIds, [])

        // Given to another installation by a person, it keeps none of it.
        yield* replaceInstallationId(restarted, state, {
          expectedInstallationId: "kiln-restored",
          installationId: "other-kiln",
        })
        const again = {
          ...restarted,
          installationId: null,
          previousInstallationIds: ["stale"],
        }
        yield* loadInstallationId(again, state)
        assert.strictEqual(again.installationId, "other-kiln")
        assert.deepStrictEqual(again.previousInstallationIds, [])
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
    previousInstallationIds: ReadonlyArray<string>
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
        previousInstallationIds: [],
        provenHearth: null,
      }).pipe(
        Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
      ),
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}
