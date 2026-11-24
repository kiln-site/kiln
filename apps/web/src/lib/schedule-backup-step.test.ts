import { describe, expect, it } from "vite-plus/test"

import type { ScheduleTarget } from "@workspace/contracts/schedules"

import {
  appVolumes,
  backupStep,
  backupStepTargetKeys,
  type ScheduleBackupAction,
} from "./schedule-backup-step"

const relayId = "a".repeat(12)

function target(kind: ScheduleTarget["kind"], name: string, permitted = true) {
  return {
    canCreate: permitted,
    canUpdate: permitted,
    id: name,
    kind,
    name,
    permittedActions: permitted ? (["backup"] as const) : [],
    relayId,
  }
}

const server = target("instance", "server")
const site = target("app", "site")
const bare = target("app", "bare")
const uploads = target("volume", "uploads")
const others = target("database", "others", false)

const volumes = appVolumes({
  listed: [relayId],
  options: [
    { name: "uploads", relayId, usedBy: [{ id: "site" }] },
    { name: "cache", relayId, usedBy: [{ id: "site" }] },
  ],
})

function step(
  targets: ReadonlyArray<ReturnType<typeof target>>,
  action: Partial<ScheduleBackupAction> = {},
  used = volumes
) {
  return backupStep(
    {
      destination: { kind: "local" },
      id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
      mode: "full",
      name: "Nightly",
      type: "backup",
      ...action,
    },
    targets,
    used,
    "canUpdate"
  )
}

const names = (keys: ReadonlyArray<string> | undefined) =>
  keys?.map((key) => key.split(":").at(-1))

/** What a step names once saved, by default with what it chose. */
const saved = (
  some: ReturnType<typeof step>,
  mode: ScheduleBackupAction["mode"] = "full",
  chosen = some.chosen
) => names(backupStepTargetKeys(some, mode, chosen))

describe("a schedule's backup step", () => {
  it("takes every target, and later ones, once all are chosen", () => {
    const every = step([server, site])
    expect(names(every.chosen)).toEqual(["server", "site"])
    expect(saved(every)).toBeUndefined()
    expect(saved(every, "full", every.chosen.slice(0, 1))).toEqual(["server"])
  })

  it("covers later game servers, and nothing more, when incremental", () => {
    const incremental = step([server, site], { mode: "incremental" })
    expect(names(incremental.chosen)).toEqual(["server"])
    expect(saved(incremental, "incremental")).toBeUndefined()
    // Made full, naming none would take the App too.
    expect(saved(incremental, "full")).toEqual(["server"])
  })

  it("never reaches what this person can't back up", () => {
    const some = step([server, others])
    expect(names(some.chosen)).toEqual(["server"])
    expect(saved(some)).toEqual(["server"])
  })

  it("covers later game servers past a database this person can't back up", () => {
    const incremental = step([server, others], { mode: "incremental" })
    expect(saved(incremental, "incremental")).toBeUndefined()
    expect(saved(incremental, "full")).toEqual(["server"])
  })

  it("keeps covering later game servers once its last one is gone", () => {
    const incremental = step([others], { mode: "incremental" })
    expect(saved(incremental, "incremental")).toBeUndefined()
  })

  it("keeps an App it names while its volumes are gone", () => {
    const named = step([bare, server], {
      targetKeys: [`${relayId}:app:bare`],
    })
    expect(saved(named)).toEqual(["bare"])
    expect(named.counts).toMatchObject({ apps: 0, volumes: 0 })
  })

  it("keeps one it names that this person can't back up removable", () => {
    const named = step([server, others], {
      targetKeys: [`${relayId}:database:others`],
    })
    expect(
      named.listed.map(({ option, removeOnly }) => [option.name, removeOnly])
    ).toEqual([
      ["server", false],
      ["others", true],
    ])
    expect(names(named.chosen)).toEqual(["others"])
    expect(named.counts).toMatchObject({ databases: 0, instances: 0 })
  })

  it("counts each volume once, and leaves out an App without any", () => {
    const both = step([site, uploads, bare])
    expect(both.counts).toMatchObject({ apps: 1, volumes: 2 })
    expect(both.empty).toEqual([bare])
  })

  it("doesn't take an App to have no volumes before its Relay says so", () => {
    const unknown = step([bare], {}, appVolumes(undefined))
    expect(names(unknown.chosen)).toEqual(["bare"])
    expect(unknown.counts).toEqual({
      apps: 1,
      databases: 0,
      instances: 0,
      relays: 0,
    })
  })
})
