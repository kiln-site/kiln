import {
  fileRootOwner,
  relayReadOnlyMachineActions,
  type FileRootOwner,
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
  "instance.read",
  "instance.create",
  "instance.delete",
  "instance.rename",
  "instance.power.start",
  "instance.power.stop",
  "instance.power.restart",
  "instance.power.kill",
  "instance.console.read",
  "instance.console.write",
  "instance.sftp.connect",
  "instance.files.list",
  "instance.files.read",
  "instance.files.create",
  "instance.files.write",
  "instance.files.delete",
  "instance.files.rename",
  "instance.files.chmod",
  "instance.files.download",
  "instance.files.upload",
  "instance.files.upload-url",
  "instance.network.read",
  "instance.network.write",
  "instance.logs.read",
  "instance.logs.share",
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
      return "instance.files.delete"
    case "rename":
      return "instance.files.rename"
    case "duplicate":
    case "archive":
    case "unarchive":
      return "instance.files.write"
    default:
      return null
  }
}

// An App's files and the host's each take one action to read and one to
// change. A game server's take an action for each operation
// (`actionForRequest`), so it has no row here.
const fileRootActions = {
  app: { read: "app.files.read", write: "app.files.write" },
  relay: { read: "relay.files.read", write: "relay.files.write" },
} as const satisfies Partial<
  Record<FileRootOwner["kind"], Record<"read" | "write", RelayAction>>
>

/**
 * The action reading or changing a file root's files takes, where its kind
 * has one for each. Null for a game server's root.
 */
export function fileRootAction(
  rootId: string,
  access: "read" | "write"
): RelayAction | null {
  const { kind } = fileRootOwner(rootId)
  return kind === "app" || kind === "relay"
    ? fileRootActions[kind][access]
    : null
}
