import { listIconIndexEffect } from "@/effect/icons"
import { runAppEffect } from "@/effect/runtime"
import {
  grantsAllowPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { IconSubject, InstanceIconSubject } from "@/lib/icons"
import type { AccessPermission } from "@/lib/permissions"
import { activeRelay } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"

// Server-only helpers for icons, kept apart from the server functions in
// icons.ts so their server imports stay out of the client bundle.

type InstanceKind = InstanceIconSubject["kind"]

// Seeing an icon takes reading what it belongs to; changing one takes what
// renaming it does.
const readPermissions = {
  server: "instance.read",
  app: "app.read",
  database: "database.read",
} as const satisfies Record<InstanceKind, AccessPermission>

const editPermissions = {
  server: "instance.configuration.write",
  app: "app.manage",
  database: "database.delete",
} as const satisfies Record<InstanceKind, AccessPermission>

// Copying an icon from a file takes reading that file.
const filePermissions = {
  server: "instance.files.read",
  app: "app.files.read",
} as const satisfies Partial<Record<InstanceKind, AccessPermission>>

function permissionTarget(subject: InstanceIconSubject) {
  return subject.kind === "server"
    ? { instanceId: subject.id }
    : subject.kind === "app"
      ? { appId: subject.id }
      : { databaseId: subject.id }
}

/**
 * The signed-in user, once they may see (`read`) or change (`edit`) the
 * subject's icon, and its Relay. A user's own picture is theirs to change;
 * anyone signed in may see one.
 */
export async function authorizedIconSubject(
  subject: IconSubject,
  access: "edit" | "read"
) {
  const user = await requireEligibleResourceUser()
  if (subject.kind === "user") {
    if (access === "edit" && subject.id !== user.id) {
      throw new Error("You can only change your own picture")
    }
    return { relay: null, user }
  }
  const relay = await activeRelay(subject.relayId)
  await requireRelayPermission({
    user,
    relayId: subject.relayId,
    permission:
      access === "edit"
        ? editPermissions[subject.kind]
        : readPermissions[subject.kind],
    ...permissionTarget(subject),
  })
  return { relay, user }
}

/** Also requires reading the files an icon is copied from. */
export async function requireIconFileAccess(
  user: AuthenticatedUser,
  subject: InstanceIconSubject & { kind: "app" | "server" }
) {
  await requireRelayPermission({
    user,
    relayId: subject.relayId,
    permission: filePermissions[subject.kind],
    ...permissionTarget(subject),
  })
}

/**
 * The icons `user` may see: the game servers, apps, and databases they can
 * read, their own picture, and, for platform administrators, everyone's.
 */
export async function iconIndexFor(user: AuthenticatedUser) {
  const admin = isPlatformAdmin(user)
  const grants = admin ? [] : await listUserGrants(user.id)
  return runAppEffect(
    "icons.index",
    listIconIndexEffect((subject) => {
      if (admin) return true
      if (subject.kind === "user") return subject.id === user.id
      return grantsAllowPermission(grants, readPermissions[subject.kind], {
        relayId: subject.relayId,
        ...permissionTarget(subject),
      })
    })
  )
}
