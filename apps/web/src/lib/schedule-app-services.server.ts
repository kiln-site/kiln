import { appIdSchema, appServiceNameSchema } from "@workspace/contracts"
import {
  scheduleActionAppliesToTarget,
  scheduleTargetKey,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"
import { Effect, Predicate, Result } from "effect"
import { z } from "zod"

import { promiseEffect } from "@/effect/promise"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"

interface AppCommand {
  readonly service: string
  readonly target: ScheduleTarget
}

/**
 * Refuses a schedule whose App command runs in a service its App doesn't
 * have, asking each App's Relay which services it runs. While a Relay can't
 * answer, only a service the schedule already ran on that App is kept, so
 * a schedule stays editable while its Relay is away. The Relay checks again
 * when the step runs.
 */
export async function requireScheduleAppServices(input: {
  readonly actions: ReadonlyArray<ScheduleAction>
  readonly existing?: { readonly actions: ReadonlyArray<ScheduleAction> }
  readonly targets: ReadonlyArray<ScheduleTarget>
}): Promise<void> {
  const commands = appCommands(input.actions, input.targets)
  if (commands.length === 0) return
  const saved = new Set(
    input.existing
      ? appCommands(input.existing.actions, input.targets).map(commandKey)
      : []
  )
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  const byRelay = new Map<string, Array<AppCommand>>()
  for (const command of commands) {
    const relayCommands = byRelay.get(command.target.relayId) ?? []
    relayCommands.push(command)
    byRelay.set(command.target.relayId, relayCommands)
  }
  await Promise.all(
    [...byRelay].map(async ([relayId, relayCommands]) => {
      const appIds = [
        ...new Set(relayCommands.map((command) => command.target.id)),
      ]
      const relay = relays.get(relayId)
      const listed = relay?.enabled
        ? await Effect.runPromise(
            Effect.result(
              promiseEffect(() =>
                relayRpc(
                  relay,
                  "app.list",
                  { requests: appIds.map((id) => ({ id, view: "detail" })) },
                  10_000
                )
              )
            )
          )
        : null
      const services =
        listed && Result.isSuccess(listed)
          ? appServices(listed.success)
          : null
      for (const command of relayCommands) {
        const { service, target } = command
        if (!services) {
          if (saved.has(commandKey(command))) continue
          throw new Error(
            `${target.name}'s Relay must be online to check its services`
          )
        }
        const known = services.get(target.id)
        if (!known?.size) {
          throw new Error(
            `Deploy ${target.name} before scheduling a command in it`
          )
        }
        if (!known.has(service)) {
          throw new Error(`${target.name} has no service named ${service}`)
        }
      }
    })
  )
}

function appCommands(
  actions: ReadonlyArray<ScheduleAction>,
  targets: ReadonlyArray<ScheduleTarget>
): Array<AppCommand> {
  return actions.flatMap((action) =>
    action.type !== "console_command"
      ? []
      : targets.flatMap((target) => {
          const service = action.services?.[scheduleTargetKey(target)]
          return target.kind === "app" &&
            service &&
            scheduleActionAppliesToTarget(action, target)
            ? [{ service, target }]
            : []
        })
  )
}

function commandKey({ service, target }: AppCommand) {
  return `${scheduleTargetKey(target)}\u001f${service}`
}

// Of an App the Relay lists, only what says which services it runs.
const listedAppSchema = z.object({
  containers: z.array(z.object({ service: appServiceNameSchema })),
  id: appIdSchema,
})

// Each App's services, as its containers report them.
function appServices(response: unknown): Map<string, Set<string>> {
  const services = new Map<string, Set<string>>()
  if (!Array.isArray(response)) return services
  for (const item of response) {
    const parsed = listedAppSchema.safeParse(
      Predicate.hasProperty(item, "app") ? item.app : item
    )
    if (!parsed.success) continue
    services.set(
      parsed.data.id,
      new Set(parsed.data.containers.map((container) => container.service))
    )
  }
  return services
}
