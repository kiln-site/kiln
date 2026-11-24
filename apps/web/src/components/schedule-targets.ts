import { scheduleTargetKey } from "@workspace/contracts/schedules"

import type { PickerTarget } from "@/components/target-picker"
import type {
  getScheduleOptions,
  getScheduleVolumeOptions,
} from "@/server/schedules"

export type ScheduleOption = Awaited<
  ReturnType<typeof getScheduleOptions>
>[number] & {
  /** For a volume, once its Relay has settled it: the Apps that use it. */
  usedBy?: ReadonlyArray<{ id: string; name: string }> | null
}
export type ScheduleVolumeOptions = Awaited<
  ReturnType<typeof getScheduleVolumeOptions>
>

/**
 * A schedule's target as the target picker lists it. A Relay target is
 * Kiln itself, backed up on that Relay. Under `permission`, one this person
 * can't schedule can't be chosen, and one that's gone can only be removed.
 */
export function schedulePickerTarget(
  option: ScheduleOption,
  permission?: "canCreate" | "canUpdate"
): PickerTarget {
  return {
    id: option.kind === "relay" ? option.relayId : option.id,
    key: scheduleTargetKey(option),
    kind: option.kind === "relay" ? "platform" : option.kind,
    name: option.kind === "relay" ? "Kiln" : option.name,
    relayId: option.relayId,
    relayName: option.relayName,
    ...(option.usedBy
      ? {
          description:
            option.usedBy.length > 0
              ? `Used by ${option.usedBy.map((user) => user.name).join(", ")}`
              : "Not used by an App",
          searchText: option.usedBy
            .map((user) => `${user.id} ${user.name}`)
            .join(" "),
        }
      : {}),
    ...(permission
      ? { disabled: !option[permission], unavailable: !option.available }
      : {}),
  }
}

/**
 * The editor's targets with each Relay's volumes as it lists them. A
 * volume a schedule names that its Relay no longer lists is gone; one on a
 * Relay that couldn't be asked stays as Hearth last knew it.
 */
export function withVolumeOptions(
  options: ReadonlyArray<ScheduleOption>,
  volumes: ScheduleVolumeOptions | undefined
): ReadonlyArray<ScheduleOption> {
  if (!volumes) return options
  const listed = new Set(volumes.listed)
  const fresh = new Map(
    volumes.options.map((option) => [scheduleTargetKey(option), option])
  )
  const merged = options.map((option): ScheduleOption => {
    if (option.kind !== "volume") return option
    const known = fresh.get(scheduleTargetKey(option))
    if (known) {
      fresh.delete(scheduleTargetKey(option))
      return known
    }
    return listed.has(option.relayId)
      ? { ...option, available: false, canCreate: false }
      : option
  })
  return [...merged, ...fresh.values()]
}

/** Targets by name, in a sentence. */
export function scheduleTargetNames(targets: ReadonlyArray<ScheduleOption>) {
  const names = [...new Set(targets.map((target) => target.name))]
  if (names.length < 2) return names[0] ?? "this target"
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
}
