import { describe, expect, it } from "vite-plus/test"

import {
  backupTargetGroups,
  type BackupVolumeListing,
} from "./backup-target-groups"

const relayId = "1".repeat(12)
const site = "a".repeat(12)
const data = "d".repeat(12)
const media = "1".repeat(40)
const uploads = "2".repeat(40)

const keyOf = (kind: string, relay: string, id: string) =>
  `${kind}:${relay}:${id}`

const volume = (id: string, name: string, users: Array<string>) => ({
  createdAt: null,
  dockerName: `kiln-${id.slice(0, 8)}`,
  id,
  kind: "kiln" as const,
  mountpoint: null,
  mounts: [],
  name,
  sizeBytes: null,
  users: users.map((appId) => ({ appId, configured: true, mounted: true })),
})

// The site uses two volumes, and is kept in a group with its database.
const listing = (change: Partial<BackupVolumeListing> = {}) => ({
  [relayId]: {
    missing: [],
    protection: { ready: true, reason: null },
    volumes: [volume(media, "media", [site]), volume(uploads, "uploads", [site])],
    ...change,
  },
})
const targets = [
  { key: keyOf("volume", relayId, media), kind: "volume", name: "media" },
  { key: keyOf("volume", relayId, uploads), kind: "volume", name: "uploads" },
  { key: keyOf("database", relayId, data), kind: "database", name: "Site" },
]
const group = {
  hidden: 0,
  id: "9".repeat(12),
  members: [
    { instanceId: site, kind: "app" as const, name: "Site", relayId },
    { instanceId: data, kind: "database" as const, name: "Site", relayId },
  ],
  name: "Site",
}

// What each row stands for, by its kind; none when it can't be chosen.
const rows = (input: {
  groups?: ReadonlyArray<typeof group>
  targets?: typeof targets
  volumes?: ReturnType<typeof listing>
}) =>
  Object.fromEntries(
    backupTargetGroups({
      apps: [{ id: site, name: "Site", relayId }],
      groups: input.groups ?? [group],
      keyOf,
      targets: input.targets ?? targets,
      volumes: input.volumes ?? listing(),
    }).map((row) => [row.kind, row.members])
  )

// A row that is chosen is taken for everything it names. One that stood for
// less than that would back part of an App or a group up and read as all of
// it, so such a row stands for nothing and can't be chosen.
describe("New Backup's App and group rows", () => {
  it("stand for every volume of an App, and with them a group's database", () => {
    expect(rows({})).toEqual({
      app: [targets[0]!.key, targets[1]!.key],
      group: targets.map((target) => target.key),
    })
  })

  it("stand for nothing while the Relay may list fewer volumes than an App uses", () => {
    const unsettled = { protection: { ready: false, reason: "Waiting" } }
    // One of its volumes is listed as its own, the other not yet.
    expect(
      rows({
        volumes: listing({
          ...unsettled,
          volumes: [volume(media, "media", [site]), volume(uploads, "uploads", [])],
        }),
      })
    ).toEqual({ app: [], group: [] })
    // None of them is.
    expect(
      rows({
        volumes: listing({
          ...unsettled,
          volumes: [volume(media, "media", []), volume(uploads, "uploads", [])],
        }),
      })
    ).toEqual({ app: [], group: [] })
  })

  it("stand for nothing when a volume the App names is gone from its Relay", () => {
    expect(
      rows({
        volumes: listing({
          missing: [{ appId: site, volumeId: "3".repeat(40) }],
        }),
      })
    ).toEqual({ app: [], group: [] })
  })

  it("leave a group unchosen when it holds what can't be seen or backed up here", () => {
    expect(rows({ groups: [{ ...group, hidden: 1 }] }).group).toEqual([])
    // Its database isn't offered, as without permission to back it up.
    expect(rows({ targets: targets.slice(0, 2) }).group).toEqual([])
    // The App alone can still be chosen for its volumes.
    expect(rows({ targets: targets.slice(0, 2) }).app).toHaveLength(2)
  })
})
