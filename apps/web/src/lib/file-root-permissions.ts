import { fileRootOwner, type FileRootOwner } from "@workspace/contracts"

import type { AccessPermission } from "@/lib/permissions"

export type FileRootAccess = "read" | "write" | "delete"

// The one place that says which permission a file root's files take. Only a
// game server tells deleting from writing, and a database's root holds its
// dumps, which its dump permissions cover.
const permissions: Record<
  FileRootOwner["kind"],
  Record<FileRootAccess, AccessPermission>
> = {
  app: {
    read: "app.files.read",
    write: "app.files.write",
    delete: "app.files.write",
  },
  database: {
    read: "database.dump.export",
    write: "database.dump.import",
    delete: "database.dump.import",
  },
  instance: {
    read: "instance.files.read",
    write: "instance.files.write",
    delete: "instance.files.delete",
  },
  relay: {
    read: "relay.files.read",
    write: "relay.files.write",
    delete: "relay.files.write",
  },
}

export interface FileRootPermission {
  readonly permission: AccessPermission
  /** The grant scope the permission is checked in, on the root's Relay. */
  readonly scope: {
    readonly appId?: string
    readonly databaseId?: string
    readonly instanceId?: string
  }
}

/**
 * What reading, changing or deleting a file root's files takes on its Relay.
 * Null for another Relay's host files, which this Relay doesn't have.
 */
export function fileRootPermission(
  relayId: string,
  rootId: string,
  access: FileRootAccess
): FileRootPermission | null {
  const owner = fileRootOwner(rootId)
  const permission = permissions[owner.kind][access]
  switch (owner.kind) {
    case "relay":
      return owner.id === relayId ? { permission, scope: {} } : null
    case "app":
      return { permission, scope: { appId: owner.id } }
    case "database":
      return { permission, scope: { databaseId: owner.id } }
    case "instance":
      return { permission, scope: { instanceId: owner.id } }
    default:
      return owner.kind satisfies never
  }
}
