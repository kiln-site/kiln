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

type SchedulePowerAction = Extract<ScheduleAction, { type: "power" }>

/** Power actions carry their own sub-permission, so enforcement never guesses one. */
type ScheduleActionPermissionInput =
  | Pick<Exclude<ScheduleAction, { type: "power" }>, "type">
  | Pick<SchedulePowerAction, "action" | "type">

const instancePowerPermissions = [
  "instance.power.start",
  "instance.power.stop",
  "instance.power.restart",
  "instance.power.kill",
] as const satisfies ReadonlyArray<AccessPermission>

export function scheduleActionPermission(
  action: ScheduleActionPermissionInput,
  target: Pick<ScheduleTarget, "kind">
): AccessPermission | null {
  if (action.type === "wait") return null
  if (action.type === "console_command") {
    return target.kind === "instance" ? "instance.console.write" : null
  }
  if (action.type === "power") {
    if (target.kind === "instance") return `instance.power.${action.action}`
    if (target.kind === "database") return "database.power"
    return null
  }
  return "backup.create"
}

/**
 * Offering an action only asks whether the caller could schedule it at all.
 * A power option needs any instance power sub-permission; the enforcement path
 * still checks the exact action the schedule runs.
 */
export function scheduleActionOptionPermissions(
  type: ScheduleAction["type"],
  target: Pick<ScheduleTarget, "kind">
): ReadonlyArray<AccessPermission> {
  if (type === "power") {
    if (target.kind === "instance") return instancePowerPermissions
    return target.kind === "database" ? ["database.power"] : []
  }
  const permission = scheduleActionPermission({ type }, target)
  return permission === null ? [] : [permission]
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
