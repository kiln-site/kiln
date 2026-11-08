import {
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  isRelayFileRoot,
  relayReadOnlyMachineActions,
} from "@workspace/contracts"
import { Schema } from "effect"

import type { RelayClientRole } from "./effect/state.js"

export const relayActions = [
  "relay.read",
  "relay.rename",
  "relay.configure",
  "relay.update",
  "relay.audit.read",
  "relay.logs.read",
  "relay.terminal",
  "relay.database.read",
  "relay.files.read",
  "relay.files.write",
  "relay.files.mount",
  "relay.files.download",
  "relay.files.upload",
  "relay.pairing.create",
  "relay.pairing.list",
  "relay.pairing.revoke",
  "relay.clients.list",
  "relay.clients.update",
  "relay.clients.revoke",
  "brick.read",
  "database.read",
  "database.create",
  "database.delete",
  "database.power",
  "database.credentials.rotate",
  "database.network.write",
  "database.dump.export",
  "database.dump.import",
  "database.logs.read",
  "app.read",
  "app.create",
  "app.manage",
  "app.delete",
  "app.logs.read",
  "app.terminal",
  "app.files.read",
  "app.files.write",
  "app.files.download",
  "app.files.upload",
  "backup.read",
  "backup.create",
  "backup.download",
  "backup.restore",
  "backup.delete",
  "schedule.read",
  "schedule.write",
  "server.read",
  "server.create",
  "server.delete",
  "server.rename",
  "server.power.start",
  "server.power.stop",
  "server.power.restart",
  "server.power.kill",
  "server.console.read",
  "server.console.write",
  "server.sftp.connect",
  "server.files.list",
  "server.files.read",
  "server.files.create",
  "server.files.write",
  "server.files.delete",
  "server.files.rename",
  "server.files.chmod",
  "server.files.download",
  "server.files.upload",
  "server.files.upload-url",
  "server.network.read",
  "server.network.write",
  "server.logs.read",
  "server.logs.share",
] as const

export type RelayAction = (typeof relayActions)[number]

export const RelayActionSchema = Schema.Literals(relayActions)

const readOnlyActions: ReadonlySet<string> = new Set(
  relayReadOnlyMachineActions
)

export function actionsForRole(
  role: RelayClientRole,
  customActions: ReadonlyArray<string> = []
): ReadonlyArray<RelayAction> {
  if (role === "full_access") return relayActions
  if (role === "read_only") {
    return relayActions.filter((action) => readOnlyActions.has(action))
  }
  return relayActions.filter((action) => customActions.includes(action))
}

export function isActionAllowed(
  grantedActions: ReadonlyArray<string>,
  action: RelayAction
): boolean {
  return grantedActions.includes(action)
}

/** Mutations share a protocol endpoint, but deleting never follows from edit authority. */
export function fileMutationAction(
  operation: string | null
): RelayAction | null {
  switch (operation) {
    case "delete":
      return "server.files.delete"
    case "rename":
      return "server.files.rename"
    case "duplicate":
    case "archive":
    case "unarchive":
      return "server.files.write"
    default:
      return null
  }
}

/**
 * The action that moves files out of or into a file root: a game server's,
 * an App's data (`app:<appId>`), a database's dumps (`database:<id>`), or
 * the host's.
 */
export function fileTransferAction(
  rootId: string,
  direction: "download" | "upload"
): RelayAction {
  const upload = direction === "upload"
  if (isRelayFileRoot(rootId)) {
    return upload ? "relay.files.upload" : "relay.files.download"
  }
  if (databaseIdFromFileRoot(rootId) !== null) {
    return upload ? "database.dump.import" : "database.dump.export"
  }
  if (appIdFromFileRoot(rootId) !== null) {
    return upload ? "app.files.upload" : "app.files.download"
  }
  return upload ? "server.files.upload" : "server.files.download"
}
