import { appBackupVolumes, type RelayVolumes } from "@workspace/contracts"

import type { PickerGroup } from "@/components/target-picker"

/** What a Relay says of its volumes, as far as choosing them goes. */
export type BackupVolumeListing = Pick<
  RelayVolumes,
  "missing" | "protection" | "volumes"
>

interface GroupMember {
  instanceId: string
  kind: "app" | "database" | "server"
  /** Null for a game server, whose name its Relay keeps. */
  name: string | null
  relayId: string
}

/**
 * The rows of a target picker that stand for several targets: each group
 * of instances, for its members, and in New Backup each App, for the
 * volumes it uses. A row names exactly what choosing it chooses, and stands
 * for all it holds or can't be chosen: ticking one for part of it would
 * pass for choosing all of it.
 *
 * What an App is differs: New Backup backs up what an App keeps, each
 * volume it uses, so an App stands for its volumes there (`app: "volumes"`,
 * with each Relay's `volumes`); a schedule names the App itself, which is
 * backed up as whatever volumes it uses when it runs (`app: "target"`).
 */
export function targetPickerGroups({
  app,
  apps = [],
  groups,
  keyOf,
  targets,
  volumes = {},
}: {
  app: "target" | "volumes"
  /** Each App, given a row of its own where it stands for its volumes. */
  apps?: ReadonlyArray<{ id: string; name: string; relayId: string }>
  groups: ReadonlyArray<{
    /** Members whoever is choosing can't see. */
    hidden: number
    id: string
    members: ReadonlyArray<GroupMember>
    name: string
  }>
  /** A target's key in `targets`, by its kind, Relay and ID. */
  keyOf: (
    kind: "app" | "database" | "instance" | "volume",
    relayId: string,
    id: string
  ) => string
  /** What can be chosen, each a target of its own. */
  targets: ReadonlyArray<{ key: string; kind: string; name: string }>
  /** Each Relay's volumes, where they could be listed. */
  volumes?: Readonly<Record<string, BackupVolumeListing>>
}): Array<PickerGroup> {
  const offered = new Map(targets.map((target) => [target.key, target]))
  // What a row chooses, by name; what isn't a volume says what it is, since
  // a database is often called what its App is.
  const kinds: Record<string, string> = {
    app: "App",
    database: "database",
    instance: "game server",
  }
  const named = (keys: ReadonlyArray<string>) =>
    keys
      .map((key) => {
        const target = offered.get(key)
        const kind = target ? kinds[target.kind] : undefined
        return target ? `${target.name}${kind ? ` (${kind})` : ""}` : key
      })
      .join(", ")
  // What an App stands for: each volume it uses, or why it can't be chosen.
  const ofApp = (relayId: string, appId: string) => {
    const listing = volumes[relayId]
    // Its volumes can't be listed, so nothing can be said of it.
    if (!listing) return null
    const members = appBackupVolumes(appId, listing.volumes).map((volume) =>
      keyOf("volume", relayId, volume.id)
    )
    return {
      members,
      // Until every Hearth has told the Relay which volumes its Apps name,
      // the ones listed for an App may not be all it uses.
      unavailable: !listing.protection.ready
        ? "Its Relay doesn't know yet which volumes it uses"
        : listing.missing.some((gone) => gone.appId === appId)
          ? "A volume it uses is missing on its Relay"
          : members.some((key) => !offered.has(key))
            ? "Takes permission to back up each volume it uses"
            : null,
    }
  }
  const rows: Array<PickerGroup> = []
  for (const group of groups) {
    const [first] = group.members
    if (!first) continue
    const members: Array<string> = []
    let unavailable: string | null =
      group.hidden > 0 ? "Holds instances you can't see" : null
    for (const member of group.members) {
      if (member.kind === "app" && app === "volumes") {
        const app = ofApp(member.relayId, member.instanceId)
        const why = app ? app.unavailable : "Its volumes can't be listed"
        if (why) {
          unavailable ??= `${member.name ?? "An App"}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`
        }
        members.push(...(app?.members ?? []))
        continue
      }
      const key = keyOf(
        member.kind === "server" ? "instance" : member.kind,
        member.relayId,
        member.instanceId
      )
      if (offered.has(key)) members.push(key)
      else {
        unavailable ??= `${member.name ?? (member.kind === "server" ? "A game server" : member.kind === "app" ? "An App" : "A database")} can't be chosen here`
      }
    }
    const keys = [...new Set(members)]
    const nothing = keys.length === 0 ? "Nothing in it to choose" : null
    rows.push({
      description: unavailable ?? nothing ?? named(keys),
      id: group.id,
      key: `group:${group.id}`,
      kind: "group",
      members: unavailable ? [] : keys,
      name: group.name,
      relayId: first.relayId,
      searchText: group.members
        .map((member) => `${member.instanceId} ${member.name ?? ""}`)
        .join(" "),
    })
  }
  for (const one of app === "volumes" ? apps : []) {
    const stands = ofApp(one.relayId, one.id)
    if (!stands) continue
    const nothing = stands.members.length === 0 ? "No volumes to back up" : null
    const unavailable = stands.unavailable ?? nothing
    rows.push({
      description: unavailable ?? named(stands.members),
      id: one.id,
      key: `group:app:${one.relayId}:${one.id}`,
      kind: "app",
      members: unavailable ? [] : stands.members,
      name: one.name,
      relayId: one.relayId,
    })
  }
  return rows
}
