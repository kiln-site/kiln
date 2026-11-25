import { createHash } from "node:crypto"

import {
  RELAY_VOLUME_NAME_MAX_LENGTH,
  appFileRootId,
  appVolumeFileRootId,
  relayAppSchema,
  type AppConfig,
  type RelayApp,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  loadAppGitHubSourceEffect,
  saveAppGitHubSourceEffect,
} from "@/effect/app-deployments"
import { reserveInstanceIdEffect } from "@/effect/instance-ids"
import { loadAppConfigEffect } from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  fail,
  moveWebRoutes,
  ownerHandOver,
  recordedIn,
  relay,
  relays,
  webRouteHostnames,
  type MigratedKind,
  type Migration,
  type MigrationPart,
} from "@/lib/resource-migration-kinds/kind.server"
import { resolveScopeAuthorization } from "@/lib/scope-authorization.server"
import { readRelayVolumes } from "@/server/app-backups.server"

// An App is its configuration, which Hearth keeps, the folder its Relay
// keeps for it, and the volumes it writes to. Its copy is made with the
// same configuration and never deployed: its folder is filled from the old
// one's, and each volume the old one keeps data on is copied into a volume
// of the copy's own, which its configuration mounts in the old one's place.
// A volume other Apps share is copied too, and stays where it is for them.
export const apps: MigratedKind = {
  kind: "app",
  noun: "App",
  nameLimit: 120,
  powered: true,
  copiedRunning: false,
  // Nothing of its own to back up: what it keeps is on its volumes, which
  // deleting it leaves.
  finalBackup: false,
  permissions: {
    // Its configuration carries its secrets, and its files are read as
    // they are anywhere.
    copy: ["app.manage", "instance.files.read"],
    create: ["app.create"],
    delete: "app.delete",
    network: "instance.network.write",
    // Owning an App doesn't carry it, so the copy's Relay has to.
    networkThere: true,
  },
  // What making an App with its configuration takes on its Relay, as
  // installing one or saving its settings does: a path on the node reaches
  // anything there, and a file it runs or ports it publishes are made
  // there only with the Relay's `app.manage`.
  createNeeds: Effect.fnUntraced(function* (source) {
    const record = yield* loadAppConfigEffect(source.relayId, source.id)
    if (!record) return []
    const { config } = record
    return [
      ...(config.mounts.some((mount) => mount.source.type === "host")
        ? (["relay.files.write"] as const)
        : []),
      ...(config.ports.length > 0 ||
      config.compose.trim() !== "" ||
      config.dockerfile.trim() !== ""
        ? (["app.manage"] as const)
        : []),
    ]
  }),
  reserveId: (createKey) =>
    reserveInstanceIdEffect("app", `app.copy:${createKey}`),
  describe: async (source, id, subject) => {
    const [app, name] = await Promise.all([
      relayApp(source, id, subject),
      appName(source.id, id),
    ])
    return (
      app && {
        // Its services' limits are part of its configuration, which the
        // copy takes whole.
        limits: null,
        name: name ?? app.id,
        provisioning: Boolean(app.provisioning),
        running: !stopped(app),
        unbuildable:
          name === null ? "Hearth has no record of this App to copy" : null,
        usedBytes: null,
        usedFrom: "running" as const,
      }
    )
  },
  takenNames: async (destination) => {
    const { databasePool } = await import("@/lib/database")
    const [rows] = await databasePool.query<
      Array<RowDataPacket & { name: string }>
    >(`SELECT name FROM ${databaseTable("app")} WHERE relay_id = ?`, [
      destination.id,
    ])
    return rows.map((row) => row.name)
  },
  state: (source, id, subject) =>
    promiseEffect(() => relayApp(source, id, subject)).pipe(
      Effect.map(
        (app) =>
          app && {
            provisioning: app.provisioning
              ? {
                  error: app.provisioning.error ?? null,
                  failed: app.provisioning.phase === "failed",
                }
              : null,
            // A new App is made with nothing deployed.
            ready: !app.provisioning,
            stopped: stopped(app),
          }
      )
    ),
  recorded: recordedIn("app"),
  prepare: Effect.fnUntraced(function* (
    { destination, source },
    migration,
    actor,
    _options
  ) {
    const record = yield* loadAppConfigEffect(
      migration.source.relayId,
      migration.source.id
    )
    if (!record) {
      return yield* fail(`${migration.source.name} is no longer on its Relay`)
    }
    const [github, carried] = yield* Effect.all(
      [
        loadAppGitHubSourceEffect(migration.source.id),
        promiseEffect(() =>
          carriedVolumes(source, migration.source.id, record.config, actor.id)
        ),
      ],
      { concurrency: 2 }
    )
    const { environment, mounts, ...deploys } = record.config
    const names = new Map(
      carried.mounted.map((volume) => [volume.id, volume.name])
    )
    const sameRelay = source.id === destination.id
    return Effect.gen(function* () {
      // Made already, by this step before it was cut short: its Relay
      // carries on creating it.
      if (
        !(yield* recordedIn("app")(
          migration.destination.relayId,
          migration.destination.id
        ))
      ) {
        const { provisionConfiguredApp } = yield* promiseEffect(
          () => import("@/server/app-create.server")
        )
        yield* promiseEffect(() =>
          provisionConfiguredApp(actor, destination, {
            brick: record.brick ?? undefined,
            // Its databases aren't the copy's: connecting to one is asked
            // for, and one on another Relay can't be reached at all.
            databaseIds: [],
            deploys,
            environment,
            id: migration.destination.id,
            mounts: mounts.map((mount) =>
              mount.source.type === "volume"
                ? {
                    ...mount,
                    source: {
                      type: "volume" as const,
                      volumeId: copiedVolumeId(
                        migration.destination.id,
                        mount.source.volumeId
                      ),
                    },
                  }
                : mount
            ),
            name: migration.destination.name,
            // One for each volume its configuration mounts, the old one
            // there or not: the copy mounts none of the old one's.
            volumes: mountedVolumeIds(record.config).map((volumeId) => ({
              id: copiedVolumeId(migration.destination.id, volumeId),
              name: copiedVolumeName(
                names.get(volumeId) ?? migration.destination.name,
                sameRelay
              ),
            })),
          })
        )
      }
      // The repository it builds, which it doesn't deploy from by itself:
      // a push would deploy both. A move hands that over at its end.
      if (github) {
        yield* saveAppGitHubSourceEffect({
          ...github,
          appId: migration.destination.id,
          autoDeploy: false,
          createdBy: actor.id,
        })
      }
    })
  }),
  // The volumes its Compose file declares, which its Relay keeps under IDs
  // made from the App's own: the copy's are made before its first
  // deployment, to be filled.
  settled: Effect.fnUntraced(function* (migration, actor) {
    const [source, destination] = yield* relays(migration)
    const carried = yield* sourceVolumes(source, migration, actor.id)
    if (carried.declared.length === 0) return
    yield* promiseEffect(async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      await relayRpc(
        destination,
        "app.volumes.keep",
        {
          appId: migration.destination.id,
          keys: carried.declared.map(({ key }) => key),
          name: migration.destination.name,
        },
        30_000,
        actor.id
      )
    })
  }),
  sourceRoots: Effect.fnUntraced(function* (relayId, id) {
    const record = yield* loadAppConfigEffect(relayId, id)
    if (!record) return [appFileRootId(id)]
    const source = yield* relay(relayId)
    const carried = yield* promiseEffect(() =>
      carriedVolumes(source, id, record.config, undefined)
    )
    return [
      appFileRootId(id),
      ...[
        ...carried.mounted,
        ...carried.declared.map(({ volume }) => volume),
      ].map((volume) => appVolumeFileRootId(id, volume.id)),
    ]
  }),
  parts: Effect.fnUntraced(function* (migration) {
    const [source, destination] = yield* relays(migration)
    const carried = yield* sourceVolumes(source, migration, undefined)
    const from = migration.source.id
    const to = migration.destination.id
    const parts: Array<MigrationPart> = [
      { destination: appFileRootId(to), source: appFileRootId(from) },
      ...carried.mounted.map((volume) => ({
        destination: appVolumeFileRootId(to, copiedVolumeId(to, volume.id)),
        source: appVolumeFileRootId(from, volume.id),
      })),
    ]
    if (carried.declared.length === 0) return parts
    // Each key's volume as the copy's Relay kept it.
    const { volumes: there } = yield* promiseEffect(() =>
      readRelayVolumes(destination)
    )
    for (const { key, volume } of carried.declared) {
      const kept = there.find((candidate) =>
        candidate.users.some(
          (user) => user.appId === to && user.composeKey === key
        )
      )
      if (!kept?.id) {
        return yield* fail(
          `${destination.name} has no volume for "${key}" of ${migration.destination.name}'s Compose file`
        )
      }
      parts.push({
        destination: appVolumeFileRootId(to, kept.id),
        source: appVolumeFileRootId(from, volume.id),
      })
    }
    return parts
  }),
  // The copy's own volumes go with a copy that's undone, for someone who
  // may delete volumes there; otherwise they stay, for whoever may.
  copyVolumes: Effect.fnUntraced(function* (migration, actor) {
    const [, destination] = yield* relays(migration)
    const mayDelete = yield* promiseEffect(() =>
      resolveScopeAuthorization({
        scope: {
          relayId: destination.id,
          resourceId: destination.id,
          resourceType: "relay",
        },
        user: actor,
      })
    ).pipe(Effect.map((there) => there.allows("relay.configure")))
    if (!mayDelete) return []
    const { volumes: there } = yield* promiseEffect(() =>
      readRelayVolumes(destination)
    )
    return there.flatMap((volume) =>
      volume.id !== null &&
      volume.users.length > 0 &&
      volume.users.every((user) => user.appId === migration.destination.id)
        ? [volume.id]
        : []
    )
  }),
  handOver: {
    owner: ownerHandOver("app"),
    routes: (migration, actor) => moveWebRoutes("app", migration, actor),
    // Deploying on a push becomes the copy's, as the old one had it, and
    // stops for the old one, which would otherwise start again by itself.
    deploys: Effect.fnUntraced(function* (migration, actor) {
      const [old, copy] = yield* Effect.all([
        loadAppGitHubSourceEffect(migration.source.id),
        loadAppGitHubSourceEffect(migration.destination.id),
      ])
      if (!old?.autoDeploy) return
      if (copy) {
        yield* saveAppGitHubSourceEffect({
          ...copy,
          autoDeploy: true,
          createdBy: actor.id,
        })
      }
      yield* saveAppGitHubSourceEffect({ ...old, autoDeploy: false })
    }),
  },
  handOverCounts: async (source, id, user, allowed) => ({
    access: 0,
    backups: { anywhere: 0, here: 0, total: 0 },
    domains: { managed: false, names: [] },
    webRoutes: allowed.network
      ? await webRouteHostnames("app", source, id, user.id)
      : [],
  }),
  warnings: async (source, id, subject) => {
    const [app, record, github] = await Promise.all([
      relayApp(source, id, subject),
      runAppEffect(
        "resourceMigrations.app.config",
        loadAppConfigEffect(source.id, id)
      ),
      runAppEffect(
        "resourceMigrations.app.source",
        loadAppGitHubSourceEffect(id)
      ),
    ])
    if (!app || !record) return { duplicate: [], migrate: [] }
    const { config } = record
    const carried = await carriedVolumes(source, id, config, subject)
    const count = (many: number, one: string, more: string) =>
      many === 1 ? one : `${many} ${more}`
    const copied = carried.mounted.length + carried.declared.length
    const shared = [
      ...carried.mounted,
      ...carried.declared.map(({ volume }) => volume),
    ].filter((volume) => volume.users.some((user) => user.appId !== id))
    const hostPaths = config.mounts.filter(
      (mount) => mount.source.type === "host"
    ).length
    const databases = app.savedDatabaseIds.length
    const both = [
      ...(copied > 0
        ? [
            `${count(copied, "Its volume is", "of its volumes are")} copied into ${count(copied, "a new volume", "new volumes")} the copy mounts instead.`,
          ]
        : []),
      ...(shared.length > 0
        ? [
            `${shared.map((volume) => volume.name).join(", ")} ${shared.length === 1 ? "is" : "are"} shared with other Apps. The copy gets its own copy of ${shared.length === 1 ? "it" : "each"}, and stops seeing what the others write.`,
          ]
        : []),
      ...(carried.unnamed.length > 0
        ? [
            `${carried.unnamed.map((volume) => volume.name).join(", ")} ${carried.unnamed.length === 1 ? "is" : "are"} mounted by its containers but named by neither its settings nor its Compose file, so ${carried.unnamed.length === 1 ? "it isn't" : "they aren't"} copied.`,
          ]
        : []),
      ...(databases > 0
        ? [
            `It's connected to ${count(databases, "a database", "databases")}. The copy isn't: its environment still names ${databases === 1 ? "it" : "them"}, and connecting is yours to do.`,
          ]
        : []),
    ]
    const elsewhere =
      hostPaths > 0
        ? [
            `It mounts ${count(hostPaths, "a path", "paths")} on ${source.name}'s node. Nothing there is copied, and the copy mounts the same ${hostPaths === 1 ? "path" : "paths"} on its own node.`,
          ]
        : []
    return {
      duplicate: [
        "The copy isn't deployed: deploy it once you've checked its settings.",
        ...both,
        ...(config.ports.length > 0 || hostPaths > 0
          ? [
              `On ${source.name} the copy would publish the same ports${hostPaths > 0 ? " and mount the same paths on the node" : ""} as this one. Change them before deploying it there.`,
            ]
          : []),
        ...(github
          ? [
              `The copy builds ${github.repository} too, and deploys only when asked.`,
            ]
          : []),
      ],
      migrate: [
        "The copy isn't deployed: deploy it once you've checked its settings. Domains that move with it don't answer until then.",
        ...both,
        ...elsewhere,
        "The old one is stopped and stays on its Relay with its volumes, until you delete them.",
        ...(github?.autoDeploy
          ? [`Deploying on a push to ${github.repository} becomes the copy's.`]
          : []),
      ],
    }
  },
}

/** Whether nothing of it runs: no container, and no deployment under way. */
function stopped(app: RelayApp): boolean {
  return (
    app.observedState !== "starting" &&
    !app.containers.some((container) => container.running)
  )
}

/**
 * The ID of the volume a copy mounts in place of one of the old one's: the
 * same however often its copy is made.
 */
function copiedVolumeId(appId: string, volumeId: string): string {
  return createHash("sha1")
    .update(`kiln.app.copy.volume\n${appId}\n${volumeId}`)
    .digest("hex")
}

// Told apart from the old one where both are on one Relay.
function copiedVolumeName(name: string, sameRelay: boolean): string {
  return sameRelay
    ? `${name.slice(0, RELAY_VOLUME_NAME_MAX_LENGTH - 5)} copy`
    : name.slice(0, RELAY_VOLUME_NAME_MAX_LENGTH)
}

function mountedVolumeIds(config: AppConfig): Array<string> {
  return [
    ...new Set(
      config.mounts.flatMap((mount) =>
        mount.source.type === "volume" ? [mount.source.volumeId] : []
      )
    ),
  ]
}

/**
 * The volumes an App keeps data on, as its Relay lists them now: those its
 * configuration mounts, those kept for its Compose file's keys, and those
 * only its containers mount, which nothing names and so no copy takes.
 */
async function carriedVolumes(
  source: PersistedRelay,
  appId: string,
  config: AppConfig,
  subject: string | undefined
) {
  const { volumes } = await readRelayVolumes(source, subject)
  const configured = new Set(mountedVolumeIds(config))
  const used = volumes.flatMap((volume) => {
    const use = volume.users.find((user) => user.appId === appId)
    return volume.kind === "kiln" && volume.id !== null && use
      ? [{ key: use.composeKey, volume: { ...volume, id: volume.id } }]
      : []
  })
  return {
    declared: used.flatMap(({ key, volume }) =>
      key === null ? [] : [{ key, volume }]
    ),
    mounted: volumes.flatMap((volume) =>
      volume.kind === "kiln" && volume.id !== null && configured.has(volume.id)
        ? [{ ...volume, id: volume.id }]
        : []
    ),
    unnamed: used.flatMap(({ key, volume }) =>
      key === null && !configured.has(volume.id) ? [volume] : []
    ),
  }
}

// The same, of a migration's old App as Hearth has its configuration now.
const sourceVolumes = Effect.fnUntraced(function* (
  source: PersistedRelay,
  migration: Migration,
  subject: string | undefined
) {
  const record = yield* loadAppConfigEffect(
    migration.source.relayId,
    migration.source.id
  )
  if (!record) {
    return yield* fail(`${migration.source.name} is no longer on its Relay`)
  }
  return yield* promiseEffect(() =>
    carriedVolumes(source, migration.source.id, record.config, subject)
  )
})

// The name Hearth keeps an App under.
async function appName(relayId: string, id: string): Promise<string | null> {
  const { databasePool } = await import("@/lib/database")
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { name: string }>
  >(
    `SELECT name FROM ${databaseTable("app")}
      WHERE relay_id = ? AND app_id = ? LIMIT 1`,
    [relayId, id]
  )
  return rows[0]?.name ?? null
}

// One App as its Relay has it, by its ID alone.
async function relayApp(
  source: PersistedRelay,
  id: string,
  subject: string | undefined
): Promise<RelayApp | null> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const [item] = z
    .array(z.object({ app: relayAppSchema.optional() }).loose())
    .parse(
      await relayRpc(
        source,
        "app.list",
        { requests: [{ id, view: "detail" }] },
        30_000,
        subject
      )
    )
  return item?.app ?? null
}
