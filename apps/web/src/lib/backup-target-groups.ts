import { appBackupVolumes, type RelayVolumes } from "@workspace/contracts"

import type { BackupConfigurationGroup } from "@/components/backup-configuration-dialog"

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
 * The rows of New Backup that stand for several targets: each App, for the
 * volumes it uses, and each group of instances, for what each member keeps.
 * A row names exactly what choosing it chooses, and stands for all it keeps
 * or can't be chosen: ticking one for part of what it holds would pass for
 * backing all of it up.
 */
export function backupTargetGroups({
  apps,
  groups,
  keyOf,
  targets,
  volumes,
}: {
  apps: ReadonlyArray<{ id: string; name: string; relayId: string }>
  groups: ReadonlyArray<{
    /** Members whoever is choosing can't see. */
    hidden: number
    id: string
    members: ReadonlyArray<GroupMember>
    name: string
  }>
  /** A target's key in `targets`, by its kind, Relay and ID. */
  keyOf: (
    kind: "database" | "instance" | "volume",
    relayId: string,
    id: string
  ) => string
  /** What can be chosen, each a backup of its own. */
  targets: ReadonlyArray<{ key: string; kind: string; name: string }>
  /** Each Relay's volumes, where they could be listed. */
  volumes: Readonly<Record<string, BackupVolumeListing>>
}): Array<BackupConfigurationGroup> {
  const offered = new Map(targets.map((target) => [target.key, target]))
  // What a row chooses, by name; what isn't a volume says what it is, since
  // a database is often called what its App is.
  const kinds: Record<string, string> = {
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
  const rows: Array<BackupConfigurationGroup> = []
  for (const group of groups) {
    const [first] = group.members
    if (!first) continue
    const members: Array<string> = []
    let unavailable: string | null =
      group.hidden > 0 ? "Holds instances you can't see" : null
    for (const member of group.members) {
      if (member.kind === "app") {
        const app = ofApp(member.relayId, member.instanceId)
        const why = app ? app.unavailable : "Its volumes can't be listed"
        if (why) {
          unavailable ??= `${member.name ?? "An App"}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`
        }
        members.push(...(app?.members ?? []))
        continue
      }
      const key = keyOf(
        member.kind === "server" ? "instance" : "database",
        member.relayId,
        member.instanceId
      )
      if (offered.has(key)) members.push(key)
      else {
        unavailable ??= `${member.name ?? (member.kind === "server" ? "A game server" : "A database")} can't be backed up here`
      }
    }
    const keys = [...new Set(members)]
    const nothing = keys.length === 0 ? "Nothing in it to back up" : null
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
  for (const app of apps) {
    const stands = ofApp(app.relayId, app.id)
    if (!stands) continue
    const nothing = stands.members.length === 0 ? "No volumes to back up" : null
    const unavailable = stands.unavailable ?? nothing
    rows.push({
      description: unavailable ?? named(stands.members),
      id: app.id,
      key: `group:app:${app.relayId}:${app.id}`,
      kind: "app",
      members: unavailable ? [] : stands.members,
      name: app.name,
      relayId: app.relayId,
    })
  }
  return rows
}
