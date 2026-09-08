import {
  scheduleActionAppliesToTarget,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts"

import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessGrant } from "@/lib/access-control"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AccessPermission } from "@/lib/permissions"
import { grantHasPermission } from "@/lib/permissions"

export function scheduleActionPermission(
  action: Pick<ScheduleAction, "type"> & {
    action?: "start" | "stop" | "restart" | "kill"
  },
  target: Pick<ScheduleTarget, "kind">
): AccessPermission | null {
  if (action.type === "wait") return null
  if (action.type === "console_command") {
    return target.kind === "instance" ? "instance.console.write" : null
  }
  if (action.type === "power") {
    if (target.kind === "instance")
      return `instance.power.${action.action ?? "start"}`
    if (target.kind === "database") return "database.power"
    return null
  }
  return "backup.create"
}

export function hasScheduleTargetPermission(input: {
  grants: ReadonlyArray<AccessGrant>
  permission: AccessPermission
  target: ScheduleTarget
  user: AuthenticatedUser
}): boolean {
  if (isPlatformAdmin(input.user)) return true
  return input.grants.some((grant) => {
    if (
      grant.relayId !== input.target.relayId ||
      !grantHasPermission(grant, input.permission)
    ) {
      return false
    }
    if (grant.resourceType === "relay") return true
    return (
      grant.resourceType === input.target.kind &&
      grant.resourceId === input.target.id
    )
  })
}

export function scheduleAuthorizationFailure(input: {
  actions: ReadonlyArray<ScheduleAction>
  grants: ReadonlyArray<AccessGrant>
  schedulePermission: AccessPermission
  targets: ReadonlyArray<ScheduleTarget>
  user: AuthenticatedUser
}): string | null {
  for (const target of input.targets) {
    if (
      !hasScheduleTargetPermission({
        grants: input.grants,
        permission: input.schedulePermission,
        target,
        user: input.user,
      })
    ) {
      return `You do not have ${input.schedulePermission} permission for ${target.name}`
    }
    for (const action of input.actions) {
      if (!scheduleActionAppliesToTarget(action, target)) continue
      const permission = scheduleActionPermission(action, target)
      if (
        permission &&
        !hasScheduleTargetPermission({
          grants: input.grants,
          permission,
          target,
          user: input.user,
        })
      ) {
        return `You do not have ${permission} permission for ${target.name}`
      }
    }
  }
  return null
}
