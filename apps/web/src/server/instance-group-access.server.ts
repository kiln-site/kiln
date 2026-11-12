import { Effect } from "effect"

import {
  deleteInstanceGroupEffect,
  instanceGroupOfEffect,
  listInstanceGroupsEffect,
  loadInstanceGroupEffect,
  type InstanceGroup,
  type InstanceGroupMember,
  type NamedInstanceGroupMember,
} from "@/effect/instance-groups"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireDeleteConfirmation } from "@/lib/delete-confirmation.server"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requestResourceDeletion } from "@/lib/resource-deletion.server"
import { exclusive, instanceGroupKey } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"

// A group has no people of its own: what someone may do with it follows
// from what they may do with its members. They see the members they may
// read, and may delete the group when they may delete every member.

const access = {
  app: { delete: "app.delete", deletes: "app", read: "app.read" },
  database: {
    delete: "database.delete",
    deletes: "database",
    read: "database.read",
  },
  server: {
    delete: "instance.delete",
    deletes: "instance",
    read: "instance.read",
  },
} as const satisfies Record<
  InstanceGroupMember["kind"],
  {
    delete: AccessPermission
    deletes: "app" | "database" | "instance"
    read: AccessPermission
  }
>

function requireMemberPermission(
  user: AuthenticatedUser,
  member: InstanceGroupMember,
  permission: "delete" | "read"
) {
  const { instanceId: id, kind, relayId } = member
  return requireRelayPermission({
    permission: access[kind][permission],
    relayId,
    user,
    ...(kind === "app"
      ? { appId: id }
      : kind === "database"
        ? { databaseId: id }
        : { instanceId: id }),
  })
}

const may = (
  user: AuthenticatedUser,
  member: InstanceGroupMember,
  permission: "delete" | "read"
) =>
  recoverPromise(
    () => requireMemberPermission(user, member, permission).then(() => true),
    () => false
  )

/**
 * The group an instance is in, as this person may see it: the members they
 * may read, and whether they may delete it. Null for an instance in none.
 */
export async function getInstanceGroupHandler(
  user: AuthenticatedUser,
  asked: InstanceGroupMember
) {
  await requireMemberPermission(user, asked, "read")
  const group = await runAppEffect(
    "instanceGroups.of",
    instanceGroupOfEffect(asked.instanceId)
  )
  // An ID asked about as another kind, or on another Relay, than it is was
  // checked against the wrong permission.
  const found = group?.members.find(
    (member) => member.instanceId === asked.instanceId
  )
  if (!group || found?.kind !== asked.kind || found.relayId !== asked.relayId) {
    return null
  }
  const members: Array<NamedInstanceGroupMember> = []
  let canDelete = true
  for (const member of group.members) {
    if (await may(user, member, "read")) members.push(member)
    canDelete &&= await may(user, member, "delete")
  }
  return {
    canDelete,
    /** Members this person may not see. */
    hidden: group.members.length - members.length,
    id: group.id,
    members,
    name: group.name,
  }
}

/**
 * Every group, as this person may see it: with the members they may read,
 * and left out when they may read none of them.
 */
export async function listInstanceGroupsHandler(user: AuthenticatedUser) {
  const groups = await runAppEffect(
    "instanceGroups.list",
    listInstanceGroupsEffect()
  )
  const seen = await Promise.all(
    groups.map(async (group) => {
      const read = await Promise.all(
        group.members.map((member) => may(user, member, "read"))
      )
      const members = group.members.filter((_, index) => read[index])
      return {
        /** Members this person may not see, so can't choose with it. */
        hidden: group.members.length - members.length,
        id: group.id,
        members,
        name: group.name,
      }
    })
  )
  return seen.filter((group) => group.members.length > 0)
}

export interface DeleteInstanceGroupInput {
  /** The group's name, typed to confirm. */
  confirmation: string
  /** The members to delete with it. The rest stay, in no group. */
  delete: ReadonlyArray<string>
  groupId: string
  password: string
}

// Holds the group, so nothing joins or leaves it meanwhile. Each member it
// deletes is its own deletion, which takes that member's lanes once this
// ends.
export const deleteInstanceGroup = operation<DeleteInstanceGroupInput>()({
  name: "instance-group.delete",
  doing: "Deleting this group",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => {
          const group = await runAppEffect(
            "instanceGroups.load",
            loadInstanceGroupEffect(input.groupId)
          )
          if (!group) throw new Error("This group no longer exists")
          for (const member of group.members) {
            await requireMemberPermission(person, member, "delete")
          }
          return { group, user: person }
        })
      )
    ),
  locks: ({ input }) => [exclusive(instanceGroupKey(input.groupId))],
  run: ({ context, input }) =>
    promiseEffect(() => deleteGroup(context.user, context.group, input)),
  audit: ({ input }) => ({ id: input.groupId, kind: "instance-group" }),
  publish: ({ context }) => publishGroupChange(context.group),
})

async function deleteGroup(
  user: AuthenticatedUser,
  group: InstanceGroup,
  input: DeleteInstanceGroupInput
) {
  await requireDeleteConfirmation({
    confirmation: input.confirmation,
    name: group.name,
    password: input.password,
    user,
  })
  const doomed = group.members.filter((member) =>
    input.delete.includes(member.instanceId)
  )
  // Asked for first: a member that can't be deleted now leaves the group
  // as it is, to try again.
  for (const member of doomed) {
    await requestResourceDeletion({
      finalBackup: false,
      kind: access[member.kind].deletes,
      relayId: member.relayId,
      resourceId: member.instanceId,
      storageId: null,
      user,
    })
  }
  await runAppEffect(
    "instanceGroups.delete",
    deleteInstanceGroupEffect(group.id)
  )
  return { deleting: doomed.length }
}

/** Tells open pages of a group's members that their group changed. */
export function publishGroupChange(group: {
  members: ReadonlyArray<Pick<InstanceGroupMember, "relayId">>
}) {
  const relayIds = [...new Set(group.members.map((member) => member.relayId))]
  if (relayIds.length === 0) return
  publishRealtimeChange({
    audience: { kind: "relays", relayIds },
    topics: ["instance-groups"],
    type: "hearth.invalidate",
  })
}
