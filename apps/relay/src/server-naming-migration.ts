/**
 * The one-time move from calling game servers `instance` in stored data to
 * `server` (server-naming.ts), in the state files: SQLite's records move in
 * its migration `39_server_naming` as the state store opens, and these as
 * the Relay starts, before the move to 12-character IDs reads them.
 *
 * What can't move keeps its old name: Docker labels (`kiln.instance.*`),
 * folders (`restic/instance`), and archives already made, whose manifests
 * the contracts read as `server`.
 */
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import type { RelayStateStore } from "./effect/state.js"
import { rewriteStateFiles } from "./instance-id-migration.js"
import { renameServerKindsInText } from "./server-naming.js"

const SERVER_NAMING_FILES_KEY = "server_naming_files_v1"

/**
 * Renames game servers' `instance` in the state files that name them
 * (Tailscale networks' configurations, restore journals, transfers, and
 * the rest the move to 12-character IDs rewrites), once.
 */
export async function migrateServerNaming(input: {
  readonly config: RelayConfig
  readonly state: RelayStateStore["Service"]
}): Promise<void> {
  const { config, state } = input
  if (await Effect.runPromise(state.getMetadata(SERVER_NAMING_FILES_KEY)))
    return
  const files = await rewriteStateFiles(config, (text) =>
    renameServerKindsInText(text)
  )
  await Effect.runPromise(
    state.setMetadata(SERVER_NAMING_FILES_KEY, String(Date.now()))
  )
  if (files > 0)
    console.info(`Renamed game servers to server in ${files} state files`)
}
