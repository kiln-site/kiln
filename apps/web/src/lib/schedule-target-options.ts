import { scheduleTargetKey, type ScheduleTarget } from "@workspace/contracts"

export type ScheduleTargetAvailability = ScheduleTarget & {
  available: boolean
}

export function scheduleTargetsWithAvailability(
  availableTargets: ReadonlyArray<ScheduleTarget>,
  referencedTargets: ReadonlyArray<ScheduleTarget>
): Array<ScheduleTargetAvailability> {
  const targets = new Map(
    availableTargets.map((target) => [
      scheduleTargetKey(target),
      { ...target, available: true },
    ])
  )
  for (const target of referencedTargets) {
    const key = scheduleTargetKey(target)
    if (!targets.has(key)) targets.set(key, { ...target, available: false })
  }
  return [...targets.values()]
}
