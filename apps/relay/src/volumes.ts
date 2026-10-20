import { Effect, Schema } from "effect"
import {
  relayVolumeSlug,
  type RelayVolume,
  type RelayVolumeMount,
} from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import type {
  DockerContainerSummary,
  DockerEngine,
  DockerVolume,
} from "./docker-engine.js"
import type { RelayStateStore } from "./effect/state.js"
import { traceRelayEffect } from "./effect/runtime.js"
import { relayOwnerLabels, relayOwnsLabels } from "./relay-resources.js"

const KIND_LABEL = "kiln.resource.kind"
const VOLUME_KIND = "volume"
const ID_LABEL = "kiln.volume.id"
// The name it was made with, for when the Relay's own record of it is gone.
const NAME_LABEL = "kiln.volume.name"
// How often Docker measures every volume, and how long a failed measure
// waits before the next.
const SIZE_REFRESH_MS = 60_000

export class RelayVolumeError extends Schema.TaggedError<RelayVolumeError>()(
  "RelayVolumeError",
  { message: Schema.String }
) {}

// The Relay's Docker named volumes: those Kiln made for apps to share, and
// the Relay's own data volume. Docker can't rename a volume or change its
// labels, so its name is fixed when it's made and the name it's shown by
// lives in the Relay's state. Callers hold the volume's lane lock for each
// change.
export class RelayVolumes {
  readonly #config: RelayConfig
  readonly #engine: DockerEngine
  readonly #state: RelayStateStore["Service"]
  // Sizes from Docker's last measure of every volume, by Docker name, and
  // the volumes it covered.
  #sizes: {
    covered: ReadonlySet<string>
    measuredAt: number
    values: ReadonlyMap<string, number>
  } = { covered: new Set(), measuredAt: 0, values: new Map() }
  #measureFailedAt = 0
  #measuring: Promise<void> | null = null

  constructor(
    config: RelayConfig,
    engine: DockerEngine,
    state: RelayStateStore["Service"]
  ) {
    this.#config = config
    this.#engine = engine
    this.#state = state
  }

  /** Every volume, the Relay's own first, with what mounts each. */
  list() {
    return Effect.gen({ self: this }, function* () {
      const [volumes, own, containers, names] = yield* Effect.all(
        [
          this.#volumes(),
          this.#ownVolume(),
          this.#engine.listContainers({ all: true }),
          this.#state.listVolumeNames(),
        ],
        { concurrency: "unbounded" }
      )
      const measuring = this.#measureSizes([
        ...(own ? [own.Name] : []),
        ...volumes.map((volume) => volume.Name),
      ])
      const sizes = this.#sizes.values
      const named = new Map(names.map((entry) => [entry.volumeId, entry.name]))
      const mounts = volumeMounts(containers, ownContainerId())
      const view = (
        volume: DockerVolume,
        kind: RelayVolume["kind"]
      ): RelayVolume => {
        const id =
          kind === "volume" ? (volume.Labels?.[ID_LABEL] ?? null) : null
        return {
          createdAt: volume.CreatedAt ?? null,
          dockerName: volume.Name,
          id,
          kind,
          mountpoint: volume.Mountpoint ?? null,
          mounts: mounts.get(volume.Name) ?? [],
          name:
            kind === "relay"
              ? "Relay data"
              : ((id ? named.get(id) : undefined) ??
                volume.Labels?.[NAME_LABEL] ??
                volume.Name),
          sizeBytes: sizes.get(volume.Name) ?? null,
        }
      }
      return {
        measuring,
        volumes: [
          ...(own ? [view(own, "relay")] : []),
          ...volumes
            .map((volume) => view(volume, "volume"))
            .sort((left, right) => left.name.localeCompare(right.name)),
        ],
      }
    }).pipe(Effect.withSpan("RelayVolumes.list"))
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
        kind: "volume",
        mountpoint: created.Mountpoint ?? null,
        mounts: [],
        name,
        sizeBytes: null,
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

  /** Deletes a volume and its files. One a container mounts is refused. */
  delete(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({ "kiln.volume_id": id })
      const volume = yield* this.#required(id)
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
    }).pipe(Effect.withSpan("RelayVolumes.delete"))
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

// Docker names a container's host after its ID.
function ownContainerId(): string | null {
  return process.env.HOSTNAME?.trim() || null
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
        container: container.Names[0]?.replace(/^\//u, "") ?? container.Id,
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
    return { kind: "app", resourceId: labels["kiln.app.id"] ?? null }
  }
  if (labels[KIND_LABEL] === "database") {
    return { kind: "database", resourceId: labels["kiln.database.id"] ?? null }
  }
  if (labels["kiln.server.id"]) {
    return { kind: "instance", resourceId: labels["kiln.server.id"] }
  }
  return { kind: "other", resourceId: null }
}
