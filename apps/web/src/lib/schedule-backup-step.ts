import {
  scheduleActionSupportsTarget,
  scheduleTargetKey,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"

import type { InstanceKindCountValues } from "@/components/instance-kind-counts"

export type ScheduleBackupAction = Extract<ScheduleAction, { type: "backup" }>

type BackupStepOption = Pick<
  ScheduleTarget,
  "id" | "kind" | "name" | "relayId"
> & {
  readonly canCreate: boolean
  readonly canUpdate: boolean
  readonly permittedActions: ReadonlyArray<ScheduleAction["type"]>
}

/** Which volumes Apps use, as each App's Relay last said. */
export interface AppVolumes {
  /** Not every Relay has been asked yet. */
  readonly loading: boolean
  /** An App's volumes by name, or null when its Relay hasn't said. */
  readonly of: (
    app: Pick<ScheduleTarget, "id" | "relayId">
  ) => ReadonlyArray<string> | null
}

export function appVolumes(
  listed:
    | {
        readonly listed: ReadonlyArray<string>
        readonly options: ReadonlyArray<{
          readonly name: string
          readonly relayId: string
          readonly usedBy?:
            | ReadonlyArray<{ readonly id: string }>
            | null
            | undefined
        }>
      }
    | undefined
): AppVolumes {
  const byApp = new Map<string, Array<string>>()
  const known = new Set(listed?.listed ?? [])
  for (const volume of listed?.options ?? []) {
    // Who uses one is said only once it's settled; until then no App on its
    // Relay can be said to use none.
    if (!volume.usedBy) {
      known.delete(volume.relayId)
      continue
    }
    for (const { id } of volume.usedBy) {
      const key = `${volume.relayId}/${id}`
      byApp.set(key, [...(byApp.get(key) ?? []), volume.name])
    }
  }
  return {
    loading: listed === undefined,
    of: ({ id, relayId }) =>
      known.has(relayId) ? (byApp.get(`${relayId}/${id}`) ?? []) : null,
  }
}

/** What a schedule's backup step can back up, and which of it it does. */
export interface BackupStep<Option extends BackupStepOption> {
  /**
   * What it's chosen from, whatever its mode, so the list holds still as
   * that changes: every target with something to back up that this person
   * may, and any other it names, which can only be taken off.
   */
  readonly listed: ReadonlyArray<{
    readonly key: string
    readonly option: Option
    readonly removeOnly: boolean
  }>
  /** The keys of those it backs up. */
  readonly chosen: ReadonlyArray<string>
  /** Left out: Apps that use no volume. */
  readonly empty: ReadonlyArray<Option>
  /**
   * What it backs up by kind, an App's volumes among the volumes; those are
   * unsaid while any App's aren't known.
   */
  readonly counts: InstanceKindCountValues
  /** Choosing all of it takes targets added to the schedule later too. */
  readonly coversLater: boolean
}

export function backupStep<Option extends BackupStepOption>(
  action: ScheduleBackupAction,
  targets: ReadonlyArray<Option>,
  volumes: AppVolumes,
  permission: "canCreate" | "canUpdate"
): BackupStep<Option> {
  const named = action.targetKeys && new Set(action.targetKeys)
  const listed: Array<BackupStep<Option>["listed"][number]> = []
  const chosen: Array<string> = []
  const empty: Array<Option> = []
  const counts = { apps: 0, databases: 0, instances: 0, relays: 0 }
  const volumeKeys = new Set<string>()
  let volumesKnown = true
  let restricted = false
  for (const option of targets) {
    if (!scheduleActionSupportsTarget({ ...action, mode: "full" }, option)) {
      continue
    }
    const key = scheduleTargetKey(option)
    if (!option[permission] || !option.permittedActions.includes("backup")) {
      restricted = true
      if (!named?.has(key)) continue
      listed.push({ key, option, removeOnly: true })
      chosen.push(key)
      continue
    }
    const used = option.kind === "app" ? volumes.of(option) : null
    if (used?.length === 0) {
      empty.push(option)
      continue
    }
    listed.push({ key, option, removeOnly: false })
    // Naming none, it runs on each target its mode supports.
    if (
      !(named ? named.has(key) : true) ||
      !scheduleActionSupportsTarget(action, option)
    ) {
      continue
    }
    chosen.push(key)
    if (option.kind === "relay") counts.relays += 1
    else if (option.kind === "instance") counts.instances += 1
    else if (option.kind === "database") counts.databases += 1
    else if (option.kind === "volume") {
      volumeKeys.add(`${option.relayId}/${option.name}`)
    } else {
      counts.apps += 1
      if (used === null) volumesKnown = false
      for (const name of used ?? []) {
        volumeKeys.add(`${option.relayId}/${name}`)
      }
    }
  }
  return {
    chosen,
    counts: volumesKnown ? { ...counts, volumes: volumeKeys.size } : counts,
    coversLater: !restricted,
    empty,
    listed,
  }
}

/**
 * The targets a step names once `chosen` is saved for it. All its mode can
 * back up is every target, later ones included, so it names none; unless it
 * would then reach one this person can't back up.
 */
export function backupStepTargetKeys(
  step: Pick<BackupStep<BackupStepOption>, "coversLater" | "listed">,
  mode: ScheduleBackupAction["mode"],
  chosen: ReadonlyArray<string>
): ReadonlyArray<string> | undefined {
  const every = step.listed.filter(({ option }) =>
    scheduleActionSupportsTarget({ type: "backup", mode }, option)
  )
  return step.coversLater &&
    every.length === chosen.length &&
    every.every(({ key }) => chosen.includes(key))
    ? undefined
    : chosen
}

/**
 * Whether a step of these targets can be taken stopped, and what that does:
 * Apps and volumes, which stop what uses them, alone or with databases, each
 * dumped while the Apps are stopped.
 */
export function backupStepConsistency(
  targets: ReadonlyArray<{ readonly kind: string }>
): { stoppedDescription: string; stoppedUnavailable: null } | undefined {
  const stops = ({ kind }: { readonly kind: string }) =>
    kind === "app" || kind === "volume"
  const databases = targets.some(({ kind }) => kind === "database")
  if (
    !targets.some(stops) ||
    !targets.every((target) => stops(target) || target.kind === "database")
  ) {
    return undefined
  }
  return {
    stoppedDescription: databases
      ? "Stops each App once, and dumps the databases while they are stopped"
      : "Stops each App that uses a volume it backs up",
    stoppedUnavailable: null,
  }
}
