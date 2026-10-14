import { basename, dirname } from "node:path"

import type { DatabaseReadRequest } from "@workspace/contracts"
import { Effect } from "effect"

import { relayStateDatabasePath, type RelayConfig } from "./config.js"
import { DatabaseBrowser } from "./database-browser.js"
import { FilesystemDriver } from "./files.js"

// The live state file uses the same SQLite worker as file databases. Every
// request opens it read-only; Hearth cannot commit changes through this page.
export class RelayStateDatabase {
  readonly #browser: DatabaseBrowser
  readonly #path: string

  constructor(config: RelayConfig) {
    const path = relayStateDatabasePath(config)
    this.#path = basename(path)
    this.#browser = new DatabaseBrowser(
      new FilesystemDriver({ ...config, rootDirectory: dirname(path) })
    )
  }

  read(request: DatabaseReadRequest) {
    const root = { id: "relay-state", directory: "." }
    return this.#browser
      .read(root, { instanceId: root.id, path: this.#path, request })
      .pipe(
        Effect.map((result) =>
          request.action === "overview"
            ? { ...(result as object), readOnly: true }
            : result
        )
      )
  }
}
