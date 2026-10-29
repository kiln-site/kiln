import { join } from "node:path"

import { Effect, Schema, Semaphore } from "effect"
import {
  appVolumeId,
  composeVolumeNameSchema,
  RELAY_VOLUME_REFERENCES_PENDING,
  relayVolumeSlug,
  type RelayUncoveredMount,
  type RelayVolume,
  type RelayVolumeMount,
  type RelayVolumeUser,
} from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import type {
  DockerContainerSummary,
  DockerEngine,
  DockerEngineError,
  DockerVolume,
} from "./docker-engine.js"
import type { RelayStateStore } from "./effect/state.js"
import { traceRelayEffect } from "./effect/runtime.js"
import {
  relayOwnerLabels,
  relayOwnsLabels,
  relayResourceNames,
} from "./relay-resources.js"

const KIND_LABEL = "kiln.resource.kind"
const VOLUME_KIND = "volume"
const ID_LABEL = "kiln.volume.id"
// The name it was made with, for when the Relay's own record of it is gone.
const NAME_LABEL = "kiln.volume.name"
const APP_ID_LABEL = "kiln.app.id"
const APP_SERVICE_LABEL = "kiln.app.service"
// Compose labels the volumes it makes with their project and the key the
// file declares them under, whatever Docker name the file gives them.
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"
const COMPOSE_VOLUME_LABEL = "com.docker.compose.volume"
// How often Docker measures every volume, and how long a failed measure
// waits before the next.
const SIZE_REFRESH_MS = 60_000
const REFERENCE_PERMITS = 1_024

export class RelayVolumeError extends Schema.TaggedError<RelayVolumeError>()(
  "RelayVolumeError",
  { message: Schema.String }
) {}

/** The App whose Compose project made a volume, and its name there. */
export interface AppVolumeOwner {
  readonly appId: string
  readonly volume: string
  // Made by a rolled deployment's project rather than the App's own.
  readonly rolled: boolean
}

/**
 * The App a volume's Compose labels say made it, if one of this Relay's
 * Apps did. Kiln's own volumes are never an App's, whatever labels they
 * carry.
 */
export function appVolumeOwner(
  config: Pick<RelayConfig, "resourceNamespace">,
  labels: Readonly<Record<string, string | undefined>> | null
): AppVolumeOwner | null {
  if (!labels || labels[KIND_LABEL] === VOLUME_KIND) return null
  const project = labels[COMPOSE_PROJECT_LABEL]
  const volume = composeVolumeNameSchema.safeParse(labels[COMPOSE_VOLUME_LABEL])
  if (!project || !volume.success) return null
  const base = relayResourceNames(config).appComposeProject("")
  if (!project.startsWith(base)) return null
  // `<base><App ID>`, or `<base><App ID>-<deployment>` for a rolled one.
  const match = /^([a-f0-9]{40})(-\d{14})?$/u.exec(project.slice(base.length))
  if (!match) return null
  return {
    appId: match[1]!,
    rolled: match[2] !== undefined,
    volume: volume.data,
  }
}

// The Relay's Docker named volumes: those Kiln made for Apps to share,
// those Apps' Compose projects made, and the Relay's own data volume.
// Docker can't rename a volume or change its labels, so a Kiln volume's
// name is fixed when it's made and the name it's shown by lives in the
// Relay's state. Callers hold the volume's lane lock for each change.
/**
 * Orders deletions and imports, which run beside each other, with holds of
 * a Hearth's import, which wait for those under way and run alone. It's
 * fair to holds: once one is waiting, new deletions and imports wait behind
 * it, so a steady stream of them can't keep it waiting. It runs apart from
 * the lanes, so a hold still runs while the Relay is paused.
 */
class ReferenceGate {
  readonly #permits = Semaphore.makeUnsafe(REFERENCE_PERMITS)
  // Holds waiting or running; while any are, nothing new shares the gate.
  #holds = 0
  readonly #waiting = new Set<() => void>()

  /** Runs `effect` beside other shared work, once no hold waits. */
  readonly shared = <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => {
    const attempt: Effect.Effect<A, E, R> = Effect.suspend(() =>
      this.#holds > 0
        ? Effect.callback<void>((resume) => {
            const open = () => resume(Effect.void)
            this.#waiting.add(open)
            return Effect.sync(() => {
              this.#waiting.delete(open)
            })
          }).pipe(Effect.andThen(attempt))
        : this.#permits.withPermits(1)(effect)
    )
    return attempt
  }

  /** Runs `effect` alone, after shared work already under way. */
  readonly alone = <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        this.#holds += 1
        return restore(
          this.#permits.withPermits(REFERENCE_PERMITS)(effect)
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.#holds -= 1
              if (this.#holds > 0) return
              const waiting = [...this.#waiting]
              this.#waiting.clear()
              for (const open of waiting) open()
            })
          )
        )
      })
    )
}

export class RelayVolumes {
  readonly #config: RelayConfig
  readonly #engine: DockerEngine
  readonly #hostDataDirectory: () => Promise<string>
  readonly #state: RelayStateStore["Service"]
  // Sizes from Docker's last measure of every volume, by Docker name, and
  // the volumes it covered.
  #sizes: {
    covered: ReadonlySet<string>
    measuredAt: number
    values: ReadonlyMap<string, number>
  } = { covered: new Set(), measuredAt: 0, values: new Map() }
  #measureFailedAt = 0
  // Each Hearth's latest authenticated control connection, since the Relay
  // started. Only an import that connection sent counts.
  readonly #connections = new Map<string, string>()
  // Deletions and imports share it; holding a Hearth's import takes it
  // alone, after those already under way.
  readonly #references = new ReferenceGate()
  // The connection each Hearth held its import on, whose imports, sent
  // before its database changed, no longer count.
  readonly #held = new Map<string, string>()
  #measuring: Promise<void> | null = null

  constructor(
    config: RelayConfig,
    engine: DockerEngine,
    state: RelayStateStore["Service"],
    hostDataDirectory: () => Promise<string>
  ) {
    this.#config = config
    this.#engine = engine
    this.#state = state
    this.#hostDataDirectory = hostDataDirectory
  }

  /**
   * Every volume, the Relay's own first, with what mounts each, the Apps
   * that use each, and what Apps' containers mount that no volume Kiln
   * manages holds.
   */
  list() {
    return Effect.gen({ self: this }, function* () {
      const [inventory, own, protection, host] = yield* Effect.all(
        [
          this.#inventory(),
          this.#ownVolume(),
          this.protection(),
          Effect.promise(() => this.#hostDataDirectory()),
        ],
        { concurrency: "unbounded" }
      )
      const measuring = this.#measureSizes([
        ...(own ? [own.Name] : []),
        ...inventory.volumes.map((volume) => volume.dockerName),
      ])
      const sizes = this.#sizes.values
      const sized = (volume: Omit<RelayVolume, "sizeBytes">): RelayVolume => ({
        ...volume,
        sizeBytes: sizes.get(volume.dockerName) ?? null,
      })
      const managed = new Set(
        inventory.volumes.map((volume) => volume.dockerName)
      )
      return {
        measuring,
        protection,
        uncovered: uncoveredMounts(
          this.#config,
          inventory.containers,
          managed,
          host
        ),
        volumes: [
          ...(own
            ? [
                sized(
                  volumeView(own, inventory.mounts, {
                    id: null,
                    kind: "relay",
                    name: "Relay data",
                    owner: null,
                  })
                ),
              ]
            : []),
          ...inventory.volumes
            .map(sized)
            .sort((left, right) => left.name.localeCompare(right.name)),
        ],
      }
    }).pipe(Effect.withSpan("RelayVolumes.list"))
  }

  /**
   * The managed volume with an ID, with what mounts and uses it now, or
   * null when there's none. Sizes are left out.
   */
  find(id: string) {
    return this.#inventory().pipe(
      Effect.map(
        ({ volumes }) => volumes.find((volume) => volume.id === id) ?? null
      ),
      Effect.withSpan("RelayVolumes.find", {
        attributes: { "kiln.volume_id": id },
      })
    )
  }

  // Every managed volume without its size, with the containers on the
  // daemon and what each mounts.
  #inventory() {
    return Effect.gen({ self: this }, function* () {
      const [kiln, composed, containers, names, uses] = yield* Effect.all(
        [
          this.#volumes(),
          this.#engine.listVolumes({
            filters: { label: [COMPOSE_PROJECT_LABEL] },
          }),
          this.#engine.listContainers({ all: true }),
          this.#state.listVolumeNames(),
          this.#configuredUses(),
        ],
        { concurrency: "unbounded" }
      )
      const mounts = volumeMounts(containers, ownContainerId())
      const named = new Map(names.map((entry) => [entry.volumeId, entry.name]))
      const configured = new Map<string, Array<string>>()
      for (const use of uses) {
        configured.set(use.volumeId, [
          ...(configured.get(use.volumeId) ?? []),
          use.appId,
        ])
      }
      const volumes = [
        ...kiln.map((volume) => {
          const id = volume.Labels?.[ID_LABEL] ?? null
          return volumeView(
            volume,
            mounts,
            {
              id,
              kind: "kiln",
              name:
                (id ? named.get(id) : undefined) ??
                volume.Labels?.[NAME_LABEL] ??
                volume.Name,
              owner: null,
            },
            id ? configured.get(id) : []
          )
        }),
        ...this.#ownedVolumes(composed, mounts).map(({ id, owner, volume }) =>
          volumeView(volume, mounts, {
            id,
            kind: "app",
            name: owner.volume,
            owner: { appId: owner.appId, volume: owner.volume },
          })
        ),
      ]
      return { containers, mounts, volumes }
    })
  }

  /**
   * Makes a volume named `kiln-<short ID>-<slug of its name>`. Asking again
   * for the same ID answers with the volume already made.
   */
  create(id: string, name: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({ "kiln.volume_id": id })
      const dockerName = this.dockerName(id, name)
      // An ID names one volume: a retry finds the one it made, and anything
      // else asking for the same ID is refused.
      const existing = (yield* this.#volumes()).find(
        (volume) => volume.Labels?.[ID_LABEL] === id
      )
      if (existing && existing.Name !== dockerName) {
        return yield* new RelayVolumeError({
          message: "Another volume already has this ID",
        })
      }
      const created = yield* this.#engine.createVolume({
        labels: {
          [KIND_LABEL]: VOLUME_KIND,
          [ID_LABEL]: id,
          [NAME_LABEL]: name,
          ...relayOwnerLabels(this.#config),
        },
        name: dockerName,
      })
      // Docker answers with the volume already there when the name is taken.
      if (created.Labels?.[ID_LABEL] !== id) {
        return yield* new RelayVolumeError({
          message: `A volume named ${dockerName} already exists`,
        })
      }
      yield* this.#state.setVolumeName(id, name)
      return {
        createdAt: created.CreatedAt ?? null,
        dockerName,
        id,
        kind: "kiln",
        mountpoint: created.Mountpoint ?? null,
        mounts: [],
        name,
        owner: null,
        sizeBytes: null,
        users: [],
      } satisfies RelayVolume
    }).pipe(Effect.withSpan("RelayVolumes.create"))
  }

  rename(id: string, name: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({ "kiln.volume_id": id })
      yield* this.#required(id)
      yield* this.#state.setVolumeName(id, name)
    }).pipe(Effect.withSpan("RelayVolumes.rename"))
  }

  /**
   * Deletes a volume and its files. One an App's configuration names,
   * deployed or not, or that a container mounts is refused, as is any
   * before Hearth has said which Apps' configurations name which.
   */
  delete(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({ "kiln.volume_id": id })
      const volume = yield* this.#required(id)
      const protection = yield* this.protection()
      if (!protection.ready) {
        return yield* new RelayVolumeError({
          message: `${RELAY_VOLUME_REFERENCES_PENDING}: ${protection.reason}`,
        })
      }
      const configured = new Set(
        (yield* this.#configuredUses()).flatMap((use) =>
          use.volumeId === id ? [use.appId] : []
        )
      )
      if (configured.size > 0) {
        return yield* new RelayVolumeError({
          message:
            configured.size === 1
              ? "An App's configuration mounts this volume; remove it there first"
              : `${configured.size} Apps' configurations mount this volume; remove it there first`,
        })
      }
      const containers = yield* this.#engine.listContainers({ all: true })
      const users = volumeMounts(containers, ownContainerId()).get(volume.Name)
      if (users?.length) {
        return yield* new RelayVolumeError({
          message:
            users.length === 1
              ? `${users[0]!.container} mounts this volume; remove it first`
              : `${users.length} containers mount this volume; remove them first`,
        })
      }
      yield* this.#engine.removeVolume(volume.Name)
      yield* this.#state.deleteVolumeName(id)
    }).pipe(this.#references.shared, Effect.withSpan("RelayVolumes.delete"))
  }

  /**
   * The managed volumes an App's containers or its configuration mount, and
   * those its Compose project owns, by ID: what starting or deleting it
   * reads or removes.
   */
  appVolumeIds(appId: string) {
    return this.#inventory().pipe(
      Effect.map(({ volumes }) =>
        volumes.flatMap((volume) =>
          volume.id !== null &&
          (volume.owner?.appId === appId ||
            volume.users.some((user) => user.appId === appId))
            ? [volume.id]
            : []
        )
      ),
      Effect.withSpan("RelayVolumes.appVolumeIds", {
        attributes: { "relay.app_id": appId },
      })
    )
  }

  /** The managed volumes with these Docker names, by ID. */
  idsByDockerName(dockerNames: ReadonlyArray<string>) {
    const names = new Set(dockerNames)
    return this.#inventory().pipe(
      Effect.map(({ volumes }) =>
        volumes.flatMap((volume) =>
          volume.id !== null && names.has(volume.dockerName) ? [volume.id] : []
        )
      ),
      Effect.withSpan("RelayVolumes.idsByDockerName")
    )
  }

  /** Notes a Hearth's new control connection, which owes a fresh import. */
  clientConnected(clientId: string, connectionId: string) {
    this.#connections.set(clientId, connectionId)
  }

  /**
   * Whether every paired Hearth has said which Kiln volumes its Apps'
   * configurations name, on its current control connection, so deletion
   * knows what they use; if not, who it waits for. An import counts only
   * for the connection that sent it: a Hearth whose database changed, as
   * by a restore, connects again and sends what it holds now. A Hearth
   * newly paired, or not connected since the Relay started, owes one too;
   * one revoked no longer counts, nor do the references it sent.
   */
  protection() {
    return Effect.all(
      [this.#state.listClients(), this.#state.listVolumeReferenceImports()],
      { concurrency: "unbounded" }
    ).pipe(
      Effect.map(([clients, imports]) => {
        const imported = new Map(
          imports.map((entry) => [entry.clientId, entry])
        )
        const reasons = clients.flatMap((client) => {
          const connection = this.#connections.get(client.id)
          if (connection === undefined) {
            return [`waiting for ${client.name} to connect`]
          }
          const entry = imported.get(client.id)
          if (entry?.connectionId !== connection) {
            return [
              `waiting for ${client.name} to send its Apps' configurations`,
            ]
          }
          const unresolved = entry.unresolvedAppIds.length
          return unresolved > 0
            ? [
                `${client.name} couldn't read ${unresolved === 1 ? "an App's configuration" : `${unresolved} Apps' configurations`}`,
              ]
            : []
        })
        return {
          ready: reasons.length === 0,
          reason: reasons.length > 0 ? reasons.join("; ") : null,
        }
      })
    )
  }

  /**
   * Records the Kiln volumes an App's configuration mounts, as the Hearth
   * that keeps it says, in place of those it named before. A volume it
   * didn't name before must exist, so a configuration can't take up one
   * just deleted.
   */
  writeAppReferences(
    clientId: string,
    appId: string,
    volumeIds: ReadonlyArray<string>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({ "relay.app_id": appId })
      const before = new Set(
        (yield* this.#state.listAppVolumeReferences()).flatMap((use) =>
          use.clientId === clientId && use.appId === appId ? [use.volumeId] : []
        )
      )
      const added = volumeIds.filter((id) => !before.has(id))
      if (added.length > 0) {
        const existing = new Set(
          (yield* this.#volumes()).map((volume) => volume.Labels?.[ID_LABEL])
        )
        if (added.some((id) => !existing.has(id))) {
          return yield* new RelayVolumeError({
            message: "A volume it mounts no longer exists; choose another",
          })
        }
      }
      yield* this.#state.replaceAppVolumeReferences(clientId, appId, volumeIds)
    }).pipe(Effect.withSpan("RelayVolumes.writeAppReferences"))
  }

  /**
   * Records every App configuration's volumes one Hearth keeps, sent on its
   * current control connection, in place of all it sent before, and those
   * it couldn't read, which keep deletion waiting until it reads them. Volumes that no longer exist are kept as
   * named: they protect nothing, and the App's next deployment says
   * they're gone.
   */
  importAppReferences(
    clientId: string,
    connectionId: string,
    apps: ReadonlyArray<{
      readonly appId: string
      readonly volumeIds: ReadonlyArray<string>
    }>,
    unresolvedAppIds: ReadonlyArray<string>
  ) {
    return Effect.gen({ self: this }, function* () {
      // One a connection since replaced sent holds what Hearth knew then, as
      // before its database was restored; it mustn't replace newer ones.
      if (this.#connections.get(clientId) !== connectionId) {
        return yield* new RelayVolumeError({
          message: "This connection is no longer the Hearth's current one",
        })
      }
      if (this.#held.get(clientId) === connectionId) {
        return yield* new RelayVolumeError({
          message:
            "This Hearth held its Apps' configurations on this connection; send them on a new one",
        })
      }
      yield* this.#state.importAppVolumeReferences(
        clientId,
        connectionId,
        apps,
        unresolvedAppIds
      )
    }).pipe(
      this.#references.shared,
      Effect.withSpan("RelayVolumes.importAppReferences")
    )
  }

  /**
   * Stops counting what a Hearth sent of its Apps' configurations until it
   * sends them again, as before its database is restored: what it holds
   * now may not be what it will. Waits for deletions and imports already
   * under way, so none of them decides on what it sent before.
   */
  holdAppReferences(clientId: string, connectionId: string) {
    return this.#state.holdVolumeReferenceImport(clientId).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#held.set(clientId, connectionId)
        })
      ),
      this.#references.alone,
      Effect.withSpan("RelayVolumes.holdAppReferences")
    )
  }

  /**
   * Forgets what a deleted App's configuration named, as the Hearth that
   * deleted it said; other Hearths' records go when they next send theirs.
   */
  forgetApp(clientId: string, appId: string) {
    return this.#state.deleteAppVolumeReferences(clientId, appId)
  }

  /**
   * Measures every volume in the background when the last measure is old,
   * or right away for a volume it didn't cover, such as a new one, so
   * listing never waits on Docker walking every volume. A failed measure
   * waits as long before the next try. Whether a measure is running.
   */
  #measureSizes(names: ReadonlyArray<string>): boolean {
    if (this.#measuring) return true
    const now = Date.now()
    if (now - this.#measureFailedAt < SIZE_REFRESH_MS) return false
    const stale = now - this.#sizes.measuredAt >= SIZE_REFRESH_MS
    if (!stale && names.every((name) => this.#sizes.covered.has(name))) {
      return false
    }
    this.#measuring = Effect.runPromise(
      traceRelayEffect(
        "RelayVolumes.measure",
        this.#engine.volumeUsage({ timeout: 60_000 })
      ).pipe(
        Effect.match({
          onFailure: () => {
            this.#measureFailedAt = Date.now()
          },
          onSuccess: (usage) => {
            this.#sizes = {
              // Every volume listed when it began is covered, with those
              // Docker reports as -1 or leaves out (another driver, or
              // mount options), so they don't start a measure on every list.
              covered: new Set([
                ...names,
                ...usage.map((volume) => volume.Name),
              ]),
              measuredAt: Date.now(),
              values: new Map(
                usage.flatMap((volume) => {
                  const size = volume.UsageData?.Size
                  return size !== undefined && size >= 0
                    ? [[volume.Name, size] as const]
                    : []
                })
              ),
            }
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.#measuring = null
          })
        )
      )
    )
    return true
  }

  /** `[namespace-]kiln-<short ID>-<slug>`, as the volume's made with. */
  dockerName(id: string, name: string): string {
    const prefix = this.#config.resourceNamespace
      ? `${this.#config.resourceNamespace}-`
      : ""
    return `${prefix}kiln-${id.slice(0, 8)}-${relayVolumeSlug(name)}`
  }

  // The volumes Kiln made on this Relay, not another's sharing the daemon.
  #volumes() {
    return this.#engine
      .listVolumes({ filters: { label: [`${KIND_LABEL}=${VOLUME_KIND}`] } })
      .pipe(
        Effect.map((volumes) =>
          volumes.filter(
            (volume) =>
              relayOwnsLabels(this.#config, volume.Labels) &&
              /^[a-f0-9]{40}$/u.test(volume.Labels?.[ID_LABEL] ?? "")
          )
        )
      )
  }

  /**
   * The volumes this Relay's Apps' Compose projects made. Each App's name
   * for a volume is one ID, given to one Docker volume: the one its
   * containers mount, else the one its own project made, else the newest.
   * Another under the same name, as a file that changed the volume's Docker
   * name leaves behind, is still the App's, without an ID.
   */
  #ownedVolumes(
    volumes: ReadonlyArray<DockerVolume>,
    mounts: ReadonlyMap<string, ReadonlyArray<RelayVolumeMount>>
  ): Array<{ id: string | null; owner: AppVolumeOwner; volume: DockerVolume }> {
    const candidates = volumes.flatMap((volume) => {
      const owner = appVolumeOwner(this.#config, volume.Labels)
      return owner ? [{ owner, volume }] : []
    })
    const rank = ({ owner, volume }: (typeof candidates)[number]) => [
      (mounts.get(volume.Name) ?? []).some(
        (mount) => mount.kind === "app" && mount.resourceId === owner.appId
      )
        ? 0
        : 1,
      owner.rolled ? 1 : 0,
    ]
    const ordered = [...candidates].sort((left, right) => {
      const [leftMounted, leftRolled] = rank(left)
      const [rightMounted, rightRolled] = rank(right)
      return (
        leftMounted! - rightMounted! ||
        leftRolled! - rightRolled! ||
        (right.volume.CreatedAt ?? "").localeCompare(
          left.volume.CreatedAt ?? ""
        )
      )
    })
    const taken = new Set<string>()
    return ordered.map((candidate) => {
      const id = appVolumeId(candidate.owner.appId, candidate.owner.volume)
      if (taken.has(id)) return { ...candidate, id: null }
      taken.add(id)
      return { ...candidate, id }
    })
  }

  // The Kiln volumes Apps' configurations name, as paired Hearths sent
  // them, of Apps still on the Relay: every App has its network from when
  // it's made until it's deleted, so a deleted App's leftover record
  // protects nothing, nor does what a revoked Hearth sent.
  #configuredUses() {
    return Effect.all(
      [
        this.#state.listAppVolumeReferences(),
        this.#state.listClients(),
        this.#engine.listNetworks({
          filters: { label: [`${KIND_LABEL}=app`] },
        }),
      ],
      { concurrency: "unbounded" }
    ).pipe(
      Effect.map(([allUses, clients, networks]) => {
        const paired = new Set(clients.map((client) => client.id))
        const uses = allUses.filter((use) => paired.has(use.clientId))
        const apps = new Set(
          networks.flatMap((network) =>
            relayOwnsLabels(this.#config, network.Labels) &&
            network.Labels?.[APP_ID_LABEL]
              ? [network.Labels[APP_ID_LABEL]]
              : []
          )
        )
        return uses.filter((use) => apps.has(use.appId))
      })
    )
  }

  #required(id: string) {
    return this.#volumes().pipe(
      Effect.flatMap((volumes) => {
        const volume = volumes.find((entry) => entry.Labels?.[ID_LABEL] === id)
        return volume
          ? Effect.succeed(volume)
          : Effect.fail(new RelayVolumeError({ message: "Volume not found" }))
      })
    )
  }

  // The named volume the Relay keeps its data in, when it runs in a
  // container with one; a Relay on a bind mount or the host has none.
  #ownVolume() {
    const containerId = ownContainerId()
    if (!containerId) return Effect.succeed(null)
    return this.#engine.inspectContainer(containerId).pipe(
      Effect.flatMap((container) => {
        const mount = container.Mounts?.find(
          (entry) =>
            entry.Destination === this.#config.dataDirectory &&
            entry.Type === "volume" &&
            entry.Name
        )
        return mount?.Name
          ? this.#engine.inspectVolume(mount.Name)
          : Effect.succeed(null)
      }),
      Effect.orElseSucceed(() => null)
    )
  }
}

// The Docker name of the volume Kiln made on this Relay with an ID, or null
// when there's none, for what mounts it by ID.
export function relayVolumeDockerName(
  config: RelayConfig,
  engine: DockerEngine,
  id: string
): Effect.Effect<string | null, DockerEngineError> {
  return engine
    .listVolumes({
      filters: { label: [`${KIND_LABEL}=${VOLUME_KIND}`, `${ID_LABEL}=${id}`] },
    })
    .pipe(
      Effect.map(
        (volumes) =>
          volumes.find((volume) => relayOwnsLabels(config, volume.Labels))
            ?.Name ?? null
      )
    )
}

// Docker names a container's host after its ID.
function ownContainerId(): string | null {
  return process.env.HOSTNAME?.trim() || null
}

function volumeView(
  volume: DockerVolume,
  mounts: ReadonlyMap<string, ReadonlyArray<RelayVolumeMount>>,
  fields: Pick<RelayVolume, "id" | "kind" | "name" | "owner">,
  configuredBy: ReadonlyArray<string> = []
): Omit<RelayVolume, "sizeBytes"> {
  const mounted = mounts.get(volume.Name) ?? []
  return {
    ...fields,
    createdAt: volume.CreatedAt ?? null,
    dockerName: volume.Name,
    mountpoint: volume.Mountpoint ?? null,
    mounts: [...mounted],
    users: volumeUsers(configuredBy, mounted),
  }
}

// The Apps that use a volume: those whose configuration names it, and those
// whose containers mount it.
function volumeUsers(
  configuredBy: ReadonlyArray<string>,
  mounts: ReadonlyArray<RelayVolumeMount>
): Array<RelayVolumeUser> {
  const mounted = new Set(
    mounts.flatMap((mount) =>
      mount.kind === "app" && mount.resourceId ? [mount.resourceId] : []
    )
  )
  const configured = new Set(configuredBy)
  return [...new Set([...configured, ...mounted])].sort().map((appId) => ({
    appId,
    configured: configured.has(appId),
    mounted: mounted.has(appId),
  }))
}

// What each of this Relay's Apps' containers mounts that backups of its
// volumes and folder can't cover: volumes Kiln doesn't manage, such as
// those Docker named itself, and paths on the node outside the folders
// Kiln keeps for the App. A file the App's configuration mounts is written
// again from it on each deployment, and a repository checkout from the
// repository, so neither counts.
function uncoveredMounts(
  config: RelayConfig,
  containers: ReadonlyArray<DockerContainerSummary>,
  managed: ReadonlySet<string>,
  host: string
): Array<RelayUncoveredMount> {
  const uncovered: Array<RelayUncoveredMount> = []
  for (const container of containers) {
    const labels = container.Labels ?? {}
    const appId = labels[APP_ID_LABEL]
    if (
      labels[KIND_LABEL] !== "app" ||
      !appId ||
      !/^[a-f0-9]{40}$/u.test(appId) ||
      !relayOwnsLabels(config, labels)
    ) {
      continue
    }
    const kept = ["apps", "app-mounts", "app-sources"].map((folder) =>
      join(host, folder, appId)
    )
    for (const mount of container.Mounts ?? []) {
      let kind: RelayUncoveredMount["kind"]
      let source: string
      if (mount.Type === "volume" && mount.Name) {
        if (managed.has(mount.Name)) continue
        kind = /^[a-f0-9]{64}$/u.test(mount.Name) ? "anonymous" : "volume"
        source = mount.Name
      } else if (mount.Type === "bind") {
        if (
          kept.some(
            (folder) =>
              mount.Source === folder || mount.Source.startsWith(`${folder}/`)
          )
        ) {
          continue
        }
        kind = "bind"
        source = mount.Source
      } else {
        continue
      }
      uncovered.push({
        appId,
        container: containerName(container),
        destination: mount.Destination,
        kind,
        service: labels[APP_SERVICE_LABEL] ?? "app",
        source,
      })
    }
  }
  return uncovered
}

function containerName(container: DockerContainerSummary): string {
  return container.Names[0]?.replace(/^\//u, "") ?? container.Id
}

// Each volume's mounts by its name, with the Kiln resource each container
// belongs to.
function volumeMounts(
  containers: ReadonlyArray<DockerContainerSummary>,
  ownContainer: string | null
): ReadonlyMap<string, Array<RelayVolumeMount>> {
  const mounts = new Map<string, Array<RelayVolumeMount>>()
  for (const container of containers) {
    const { kind, resourceId } = containerResource(container, ownContainer)
    for (const mount of container.Mounts ?? []) {
      if (mount.Type !== "volume" || !mount.Name) continue
      const entries = mounts.get(mount.Name) ?? []
      entries.push({
        container: containerName(container),
        destination: mount.Destination,
        kind,
        readOnly: !mount.RW,
        resourceId,
        running: container.State === "running",
      })
      mounts.set(mount.Name, entries)
    }
  }
  return mounts
}

function containerResource(
  container: DockerContainerSummary,
  ownContainer: string | null
): Pick<RelayVolumeMount, "kind" | "resourceId"> {
  const labels = container.Labels ?? {}
  if (ownContainer && container.Id.startsWith(ownContainer)) {
    return { kind: "relay", resourceId: null }
  }
  if (labels[KIND_LABEL] === "app") {
    return { kind: "app", resourceId: labels[APP_ID_LABEL] ?? null }
  }
  if (labels[KIND_LABEL] === "database") {
    return { kind: "database", resourceId: labels["kiln.database.id"] ?? null }
  }
  if (labels["kiln.server.id"]) {
    return { kind: "instance", resourceId: labels["kiln.server.id"] }
  }
  return { kind: "other", resourceId: null }
}
