import { createHash, randomBytes } from "node:crypto"
import { statfs } from "node:fs/promises"

import type {
  DatabaseEngine,
  RelayCreateDatabase,
  RelayDatabaseAction,
  RelayDatabaseDump,
  RelayDatabaseExport,
  RelayDatabaseLimits,
  RelayDatabaseNetwork,
  RelayDatabaseContainer,
  RelayDatabaseWipe,
  RelayDeleteDatabase,
  RelayManagedDatabase,
  RelayRotateDatabaseCredentials,
  InstanceObservedState,
  ProvisioningWorkPhase,
  RelayInventoryLookup,
  RelayInventoryItem,
  ResourceLimits,
} from "@workspace/contracts"
import {
  databaseEngineSupportsLogicalBackups,
  databaseEngineSchema,
  NO_RESOURCE_LIMITS,
  relayManagedDatabaseSchema,
  resolveResourceLimits,
} from "@workspace/contracts"
import { Effect, Option, Result } from "effect"

import { traceRelayEffect, traceRelayPromise } from "./effect/runtime.js"
import type { DatabaseConnections } from "./database-connections.js"
import type { RelayConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import {
  type ContainerHealthcheck,
  createContainer,
  runWithInput,
} from "./docker-container-spec.js"
import {
  DockerEngine,
  ensureImage,
  isDockerNotFound,
  type DockerContainerSummary,
  type DockerExecProcess,
} from "./docker-engine.js"
import { provisioningStatus } from "./provisioning.js"
import { relayOwnerLabel, relayOwnsLabels } from "./relay-resources.js"
import {
  assertResourceLimitsFit,
  containerLimitSpec,
  containerResourceLimits,
} from "./resource-limits.js"

function databaseObservedState(
  container: DatabaseContainerInspect
): InstanceObservedState {
  if (container.State.Running) {
    if (container.State.Health?.Status === "starting") return "starting"
    return container.State.Health?.Status === "unhealthy" ? "failed" : "running"
  }
  return container.State.ExitCode === 0 ? "stopped" : "failed"
}

const DATABASE_KIND_LABEL = "kiln.resource.kind"
const DATABASE_KIND = "database"
const MAX_DUMP_BYTES = 700_000
// A container a limits change set aside. Discovery skips it, and Relay
// startup finishes or undoes a replacement it interrupted.
const REPLACED_MARKER = "-replaced-"
// After the marker: whether the set-aside container was running.
const RUNNING_MARKER = "running-"
const STOPPED_MARKER = "stopped-"
// Docker walks every volume to measure them, so sizes are measured at most
// this often.
const DISK_USAGE_REFRESH_MS = 5 * 60_000

interface DatabaseEngineSpec {
  command?: ReadonlyArray<string>
  dataMount: string
  image: string
  internalPort: number
}

const engineSpecs: Record<DatabaseEngine, DatabaseEngineSpec> = {
  mysql: {
    dataMount: "/var/lib/mysql",
    image: "mysql:8.4",
    internalPort: 3306,
  },
  mariadb: {
    dataMount: "/var/lib/mysql",
    image: "mariadb:11.8",
    internalPort: 3306,
  },
  postgres: {
    dataMount: "/var/lib/postgresql/data",
    image: "postgres:17",
    internalPort: 5432,
  },
  redis: {
    command: [
      "redis-server",
      "--appendonly",
      "yes",
      "--aclfile",
      "/data/users.acl",
    ],
    dataMount: "/data",
    image: "redis:8",
    internalPort: 6379,
  },
  valkey: {
    command: [
      "valkey-server",
      "--appendonly",
      "yes",
      "--aclfile",
      "/data/users.acl",
    ],
    dataMount: "/data",
    image: "valkey/valkey:8",
    internalPort: 6379,
  },
}

interface DatabaseContainerInspect {
  Config: {
    Env?: ReadonlyArray<string> | null
    Image: string
    Labels: Record<string, string | undefined> | null
  }
  HostConfig?: {
    Memory?: number
    NanoCpus?: number
  } | null
  Id: string
  Name: string
  State: {
    Error?: string
    ExitCode: number
    Health?: { Status: string }
    Running: boolean
    Status: string
  }
}

function databaseRecoveryLabels(
  config: Pick<RelayConfig, "resourceNamespace">,
  input: Pick<RelayCreateDatabase, "databaseName" | "engine" | "id" | "name">,
  createdAt: string
): Record<string, string> {
  const spec = engineSpecs[input.engine]
  const labels: Record<string, string> = {
    "kiln.database.created-at": createdAt,
    "kiln.database.database-name": input.databaseName,
    "kiln.database.engine": input.engine,
    "kiln.database.hostname": databaseHostname(input.id),
    "kiln.database.id": input.id,
    "kiln.database.image": spec.image,
    "kiln.database.name": input.name,
    "kiln.database.network": databaseResourceName(config, input.id, "network"),
    "kiln.database.volume": databaseResourceName(config, input.id, "data"),
    "kiln.relay.managed": "true",
    "kiln.relay.owned": "true",
    [DATABASE_KIND_LABEL]: DATABASE_KIND,
  }
  const owner = relayOwnerLabel(config)
  if (owner) {
    const separator = owner.indexOf("=")
    labels[owner.slice(0, separator)] = owner.slice(separator + 1)
  }
  return labels
}

/**
 * Callers hold the database's lane lock for each change (see
 * operation-plans.ts), so these methods don't lock themselves.
 */
export class DatabaseDriver {
  readonly #config: RelayConfig
  readonly #docker: DockerDriver
  readonly #engine: DockerEngine
  // Data volume sizes by volume name, from Docker's last measurement.
  #diskUsage: { measuredAt: number; sizes: ReadonlyMap<string, number> } = {
    measuredAt: 0,
    sizes: new Map(),
  }
  #diskUsageRefresh: Promise<void> | null = null

  constructor(
    config: RelayConfig,
    docker: DockerDriver,
    readonly connections: DatabaseConnections
  ) {
    this.#config = config
    this.#docker = docker
    this.#engine = new DockerEngine(config.dockerSocket)
    docker.allocations.register(DATABASE_KIND, async () =>
      (await this.#existing()).map(({ id, limits }) => ({ id, limits }))
    )
  }

  /** Every database, with the placeholders of those still provisioning. */
  async list(): Promise<Array<RelayManagedDatabase>> {
    const [databases, provisioning] = await Promise.all([
      this.#existing(),
      this.#provisioning(),
    ])
    return withProvisioning(databases, provisioning)
  }

  // The databases that exist, as their containers report them.
  async #existing(): Promise<Array<RelayManagedDatabase>> {
    this.#refreshDiskUsage()
    const [containers, diskLimits] = await Promise.all([
      this.#discover(),
      this.#diskLimits(),
    ])
    return Promise.all(
      containers.map((container) =>
        this.#toManagedDatabase(container, diskLimits)
      )
    )
  }

  // Databases still provisioning, by ID: what each shows until it exists.
  async #provisioning(): Promise<ReadonlyMap<string, RelayManagedDatabase>> {
    const jobs = await Effect.runPromise(
      this.connections.state.listProvisioningJobs()
    )
    return new Map(
      jobs.flatMap((job) =>
        job.kind === "database" ? [[job.instanceId, job.placeholder]] : []
      )
    )
  }

  /** What a database shows from its create request until it exists. */
  placeholder(input: RelayCreateDatabase): RelayManagedDatabase {
    const spec = engineSpecs[input.engine]
    return relayManagedDatabaseSchema.parse({
      connectedInstanceIds: [],
      containerId: null,
      createdAt: new Date().toISOString(),
      databaseName: input.databaseName,
      diskUsedBytes: null,
      engine: input.engine,
      hostname: databaseHostname(input.id),
      id: input.id,
      image: spec.image,
      internalPort: spec.internalPort,
      limits: NO_RESOURCE_LIMITS,
      name: input.name,
      observedState: "provisioning",
      provisioning: { attempt: 0, error: null, phase: "awaiting_claim" },
      shortId: input.id.slice(0, 8),
      status: provisioningStatus("awaiting_claim", "database"),
      supportsImportExport: databaseEngineSupportsLogicalBackups(input.engine),
    })
  }

  /** Only the requested views of the requested databases. */
  inventory(
    requests: RelayInventoryLookup["requests"],
    signal: AbortSignal
  ): Promise<Array<RelayInventoryItem>> {
    return traceRelayPromise(
      "Databases.inventory",
      async () => {
        const containers = await this.#discover(
          [...new Set(requests.map((request) => request.id))],
          signal
        )
        const byId = new Map(
          containers.map((container) => [
            requiredLabel(container.Config.Labels ?? {}, "kiln.database.id"),
            container,
          ])
        )
        const provisioning = await this.#provisioning()
        const items = await Promise.all(
          requests.map(async ({ id, view }) => {
            const container = byId.get(id)
            const placeholder = provisioning.get(id)
            if (!container) {
              return placeholder
                ? [
                    {
                      id,
                      view,
                      observedState: placeholder.observedState,
                      ...(view === "detail" && { database: placeholder }),
                    },
                  ]
                : []
            }
            const item: RelayInventoryItem = {
              id,
              view,
              observedState:
                placeholder?.observedState ?? databaseObservedState(container),
            }
            // Only the detail view needs the network's attached containers.
            if (view === "detail") {
              const [database] = withProvisioning(
                [
                  await this.#toManagedDatabase(
                    container,
                    await this.#diskLimits(),
                    signal
                  ),
                ],
                provisioning
              )
              item.database = database
            }
            return [item]
          })
        )
        return items.flat()
      },
      { "database.count": requests.length }
    )
  }

  // The database as Docker reports it, for work that runs inside it.
  async target(id: string): Promise<RelayManagedDatabase> {
    return this.#required(id)
  }

  // The database's container and data volume. Docker measures the volume on
  // request; a measurement that fails leaves its size out, not the rest.
  async inspect(id: string): Promise<RelayDatabaseContainer> {
    const container = await this.#container(id)
    const labels = container.Config.Labels ?? {}
    const volume = requiredLabel(labels, "kiln.database.volume")
    const engine = this.#engine
    const [inspected, volumes] = await Effect.runPromise(
      Effect.all(
        [
          Effect.option(engine.inspectVolume(volume)),
          engine
            .volumeUsage({ timeout: 60_000 })
            .pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: "unbounded" }
      )
    )
    this.#recordDiskUsage(volumes)
    const size = volumes.find((candidate) => candidate.Name === volume)
      ?.UsageData?.Size
    return {
      containerName: container.Name.replace(/^\//u, ""),
      dataDirectory: Option.getOrUndefined(inspected)?.Mountpoint || null,
      volumeBytes: size !== undefined && size >= 0 ? size : null,
    }
  }

  // Deletes everything in the database and leaves it empty, with the same
  // name, login, and connections.
  async wipe(input: RelayDatabaseWipe): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    if (!database.observedState.match(/^(?:running|starting)$/u)) {
      throw new Error("Start the database before wiping it")
    }
    const container = requiredContainerId(database)
    const wipe = databaseWipeClient(database, input.username, input.password)
    await Effect.runPromise(
      this.#engine.execWithInput(container, wipe.command, {
        env: wipe.env,
        input: wipe.input,
        maxOutputBytes: 64 * 1024,
        overflow: "The database wipe printed more than expected",
        timeout: 120_000,
      })
    )
    return this.#required(input.databaseId)
  }

  async backupTarget(id: string): Promise<RelayManagedDatabase> {
    const database = await this.#required(id)
    if (!databaseEngineSupportsLogicalBackups(database.engine)) {
      throw new Error(
        `${database.engine} logical backups are not supported yet`
      )
    }
    if (!database.observedState.match(/^(?:running|starting)$/u)) {
      throw new Error(
        "Start the database before creating or restoring a backup"
      )
    }
    return database
  }

  /**
   * Creates a database and waits until it accepts connections, calling
   * `onPhase` as each step starts. A failed create removes what it made.
   */
  async create(
    input: RelayCreateDatabase,
    onPhase: (phase: ProvisioningWorkPhase) => Promise<void> = async () => {}
  ): Promise<RelayManagedDatabase> {
    await onPhase("preparing")
    if ((await this.#discover([input.id])).length > 0) {
      throw new Error("Database already exists")
    }
    const spec = engineSpecs[input.engine]
    const createdAt = new Date().toISOString()
    const labels = databaseRecoveryLabels(this.#config, input, createdAt)
    const container = databaseResourceName(this.#config, input.id, "database")
    const network = labels["kiln.database.network"]
    const volume = labels["kiln.database.volume"]
    let containerCreated = false
    let networkCreated = false
    let volumeCreated = false

    const created = await promiseResult(async () => {
      await onPhase("pulling_image")
      await Effect.runPromise(ensureImage(this.#engine, spec.image))
      await onPhase("creating_container")
      await Effect.runPromise(
        this.#engine.createVolume({ labels, name: volume })
      )
      volumeCreated = true
      await Effect.runPromise(
        this.#engine.createNetwork({ internal: true, labels, name: network })
      )
      networkCreated = true
      if (input.engine === "redis" || input.engine === "valkey") {
        await writeAclFile(
          this.#engine,
          spec.image,
          volume,
          input.username,
          input.password
        )
      }
      await Effect.runPromise(
        createContainer(this.#engine, {
          command: spec.command ?? [],
          env: databaseEnvironment(input),
          healthcheck: databaseHealthcheck(input.engine),
          hostname: databaseHostname(input.id),
          image: spec.image,
          labels,
          mounts: [{ source: volume, target: spec.dataMount, type: "volume" }],
          name: container,
          network: { aliases: [databaseHostname(input.id)], name: network },
          restart: "unless-stopped",
        })
      )
      containerCreated = true
      await onPhase("finalizing")
      await Effect.runPromise(
        this.#engine.startContainer(container, { timeout: 120_000 })
      )
      await waitUntilReady(this.#engine, container)
      return await this.#required(input.id)
    })
    if (Result.isFailure(created)) {
      const engine = this.#engine
      await Effect.runPromise(
        Effect.gen(function* () {
          if (containerCreated) {
            yield* engine
              .removeContainer(container, { force: true })
              .pipe(Effect.ignore)
          }
          if (networkCreated) {
            yield* engine.removeNetwork(network).pipe(Effect.ignore)
          }
          if (volumeCreated) {
            yield* engine.removeVolume(volume).pipe(Effect.ignore)
          }
        })
      )
      throw created.failure
    }
    return created.success
  }

  /**
   * Changes the database's limits. Docker changes memory and CPU limits in
   * place, but can't remove one, so removing one recreates the container
   * over the same data volume. The Relay keeps the disk limit.
   */
  async setLimits(input: RelayDatabaseLimits): Promise<RelayManagedDatabase> {
    const container = await this.#container(input.databaseId)
    const id = input.databaseId
    const current = (
      await this.#toManagedDatabase(container, await this.#diskLimits())
    ).limits
    const next = resolveResourceLimits(current, input.limits)
    const [filesystem, others] = await Promise.all([
      statfs(this.#config.rootDirectory),
      this.#docker.allocations.others(DATABASE_KIND, id),
    ])
    assertResourceLimitsFit({
      currentDiskBytes: current.diskBytes,
      limits: next,
      nodeDiskBytes: filesystem.blocks * filesystem.bsize,
      others,
    })
    const removed = (key: "cpuMillis" | "memoryBytes") =>
      current[key] !== null && next[key] === null
    if (removed("cpuMillis") || removed("memoryBytes")) {
      // The slow path: a new container over the same data, ready again.
      await traceRelayPromise(
        "relay.databases.replaceContainer",
        () => this.#replaceContainer(container, next),
        { "relay.database_id": input.databaseId }
      )
    } else if (
      next.cpuMillis !== current.cpuMillis ||
      next.memoryBytes !== current.memoryBytes
    ) {
      const spec = containerLimitSpec(next)
      await Effect.runPromise(
        this.#engine.updateContainerResources(container.Id, {
          ...(next.memoryBytes !== null && { memoryBytes: next.memoryBytes }),
          ...(spec.nanoCpus !== undefined && { nanoCpus: spec.nanoCpus }),
        })
      )
    }
    if (next.diskBytes !== current.diskBytes) {
      await Effect.runPromise(
        this.connections.state.setDiskLimit(DATABASE_KIND, id, next.diskBytes)
      )
    }
    return this.#required(id)
  }

  // A new container over the old one's volume and network, with the same
  // environment. The old one is set aside until the new one is ready, and
  // put back if it never is.
  async #replaceContainer(
    container: DatabaseContainerInspect,
    limits: ResourceLimits
  ): Promise<void> {
    const labels = container.Config.Labels ?? {}
    const id = requiredLabel(labels, "kiln.database.id")
    const engine = databaseEngineSchema.parse(
      requiredLabel(labels, "kiln.database.engine")
    )
    const spec = engineSpecs[engine]
    const name = container.Name.replace(/^\//u, "")
    const running = container.State.Running
    // The name says whether it was running, for recovery after a restart.
    const aside = `${name}${REPLACED_MARKER}${running ? RUNNING_MARKER : STOPPED_MARKER}${randomBytes(4).toString("hex")}`
    const docker = this.#engine
    let setAside = false
    let created = false
    const replaced = await promiseResult(async () => {
      // Set aside before it stops, so a restart at any later step finds it.
      await Effect.runPromise(docker.renameContainer(container.Id, aside))
      setAside = true
      if (running) {
        await Effect.runPromise(
          docker.stopContainer(container.Id, { seconds: 30, timeout: 45_000 })
        )
      }
      await Effect.runPromise(
        createContainer(docker, {
          command: spec.command ?? [],
          env: Object.fromEntries(
            (container.Config.Env ?? []).map((entry) => {
              const separator = entry.indexOf("=")
              return [entry.slice(0, separator), entry.slice(separator + 1)]
            })
          ),
          healthcheck: databaseHealthcheck(engine),
          hostname: databaseHostname(id),
          image: labels["kiln.database.image"] ?? container.Config.Image,
          labels: stringLabels(labels),
          mounts: [
            {
              source: requiredLabel(labels, "kiln.database.volume"),
              target: spec.dataMount,
              type: "volume",
            },
          ],
          name,
          network: {
            aliases: [databaseHostname(id)],
            name: requiredLabel(labels, "kiln.database.network"),
          },
          restart: "unless-stopped",
          ...containerLimitSpec(limits),
        })
      )
      created = true
      if (running) {
        await Effect.runPromise(
          docker.startContainer(name, { timeout: 120_000 })
        )
        await waitUntilReady(docker, name)
      }
    })
    if (Result.isFailure(replaced)) {
      // The old container comes back as it was, running if it was.
      await Effect.runPromise(
        Effect.gen(function* () {
          if (created) {
            yield* docker
              .removeContainer(name, { force: true })
              .pipe(Effect.ignore)
          }
          if (setAside) yield* docker.renameContainer(container.Id, name)
          if (running) {
            yield* docker.startContainer(container.Id, { timeout: 120_000 })
          }
        }).pipe(Effect.ignore)
      )
      throw replaced.failure
    }
    // A container left behind is skipped, and removed when the Relay starts.
    await Effect.runPromise(
      docker.removeContainer(container.Id, { force: true }).pipe(Effect.ignore)
    )
  }

  /**
   * Finishes replacements a Relay restart interrupted. A set-aside container
   * whose replacement exists goes once the replacement is ready, if the
   * database was running; a replacement that won't get ready makes way for
   * it again.
   * One without a replacement goes back, running if it was.
   */
  async recoverReplacements(): Promise<void> {
    const engine = this.#engine
    const config = this.#config
    const ready = (reference: string) =>
      Effect.tryPromise({
        try: () => waitUntilReady(engine, reference),
        catch: (cause) => cause,
      })
    await Effect.runPromise(
      Effect.gen(function* () {
        const listed = (yield* engine.listContainers({
          all: true,
          filters: { label: [`${DATABASE_KIND_LABEL}=${DATABASE_KIND}`] },
        })).filter((container) => relayOwnsLabels(config, container.Labels))
        const byName = new Map(
          listed.flatMap((container) =>
            container.Names.map((name) => [name, container] as const)
          )
        )
        for (const container of listed) {
          const current = container.Names[0] ?? ""
          const marker = current.lastIndexOf(REPLACED_MARKER)
          if (marker === -1) continue
          const original = current.slice(0, marker)
          const wasRunning = !current
            .slice(marker + REPLACED_MARKER.length)
            .startsWith(STOPPED_MARKER)
          const restore = Effect.gen(function* () {
            yield* engine.renameContainer(container.Id, original.slice(1))
            if (wasRunning) {
              yield* engine.startContainer(container.Id, { timeout: 120_000 })
            }
          })
          const replacement = byName.get(original)
          if (!replacement) {
            yield* restore
            continue
          }
          // As an uninterrupted change would: the replacement of a running
          // database must be ready, started if the restart caught it first.
          if (wasRunning) {
            const started = yield* Effect.result(
              (replacement.State === "running"
                ? Effect.void
                : engine.startContainer(replacement.Id, { timeout: 120_000 })
              ).pipe(Effect.andThen(ready(replacement.Id)))
            )
            if (started._tag === "Failure") {
              yield* engine
                .removeContainer(replacement.Id, { force: true })
                .pipe(Effect.ignore)
              yield* restore
              continue
            }
          }
          yield* engine
            .removeContainer(container.Id, { force: true })
            .pipe(Effect.ignore)
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not finish interrupted database changes", {
            cause,
          })
        )
      )
    )
  }

  async action(input: RelayDatabaseAction): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    const container = requiredContainerId(database)
    if (input.action === "stop") {
      await Effect.runPromise(
        this.#engine.stopContainer(container, { seconds: 30, timeout: 45_000 })
      )
    } else if (input.action === "start") {
      await Effect.runPromise(
        this.#engine.startContainer(container, { timeout: 120_000 })
      )
      await waitUntilReady(this.#engine, container)
    } else {
      await Effect.runPromise(
        this.#engine.restartContainer(container, {
          seconds: 30,
          timeout: 150_000,
        })
      )
      await waitUntilReady(this.#engine, container)
    }
    return this.#required(input.databaseId)
  }

  delete(input: RelayDeleteDatabase) {
    return this.#delete(input)
  }

  async #delete(input: RelayDeleteDatabase) {
    const database = (await this.#existing()).find(
      (candidate) => candidate.id === input.databaseId
    )
    const labels = database ? await this.#labels(input.databaseId) : {}
    const container = database?.containerId ?? null
    const [network, volume] = await Promise.all([
      this.#ownedDatabaseResource(
        "network",
        input.databaseId,
        "network",
        labels["kiln.database.network"]
      ),
      this.#ownedDatabaseResource(
        "volume",
        input.databaseId,
        "data",
        labels["kiln.database.volume"]
      ),
    ])
    if (!container && !network && !volume) {
      throw new Error("Database not found")
    }
    const engine = this.#engine
    if (network) {
      const connected = await this.#attachedContainers(network)
      for (const attached of connected) {
        if (attached.Id === container) continue
        await Effect.runPromise(
          engine
            .disconnectNetwork(network, attached.Id, {
              force: true,
            })
            .pipe(Effect.ignore)
        )
      }
    }
    if (container) {
      await Effect.runPromise(
        engine.removeContainer(container, { force: true, timeout: 90_000 })
      )
    }
    // A network that won't go fails the delete, so it can be retried
    // rather than left behind unseen.
    if (network) {
      await Effect.runPromise(
        engine
          .removeNetwork(network)
          .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
      )
    }
    await this.connections.forgetDatabase(input.databaseId)
    await Effect.runPromise(
      this.connections.state.setDiskLimit(DATABASE_KIND, input.databaseId, null)
    )
    if (input.deleteData && volume) {
      await Effect.runPromise(engine.removeVolume(volume))
    }
    return { databaseId: input.databaseId, deleted: true }
  }

  async rotateCredentials(
    input: RelayRotateDatabaseCredentials
  ): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    const container = requiredContainerId(database)
    if (!database.observedState.match(/^(?:running|starting)$/u)) {
      throw new Error("Start the database before rotating its password")
    }
    if (database.engine === "redis" || database.engine === "valkey") {
      const engine = database.engine
      const labels = await this.#labels(database.id)
      const volume = requiredLabel(labels, "kiln.database.volume")
      await writeAclFile(
        this.#engine,
        database.image,
        volume,
        input.username,
        input.nextPassword
      )
      const loaded = await promiseResult(() =>
        this.#client(
          container,
          databaseAclLoadClient(engine, input.username, input.currentPassword),
          undefined,
          60_000
        )
      )
      if (Result.isFailure(loaded)) {
        await writeAclFile(
          this.#engine,
          database.image,
          volume,
          input.username,
          input.currentPassword
        )
        throw loaded.failure
      }
      return this.#required(input.databaseId)
    }

    const sql = rotationSql(database.engine, input.username, input.nextPassword)
    await this.#client(
      container,
      databaseClient(database, input.username, input.currentPassword, "import"),
      sql,
      60_000
    )
    return this.#required(input.databaseId)
  }

  // The caller holds the database's lock across lookup, saving intent, and
  // attachment, so a queued connect can't recreate a row after deletion has
  // cleared it.
  updateNetwork(input: RelayDatabaseNetwork): Promise<RelayManagedDatabase> {
    return this.#updateNetwork(input)
  }

  async #updateNetwork(
    input: RelayDatabaseNetwork
  ): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    const instance = await this.#docker.findInstance(input.instanceId)
    if (!instance) throw new Error("Server not found on this Relay")
    await this.connections.set(instance.id, database.id, input.connected)
    const issues = await this.connections.reconcile(
      instance.id,
      instance.service
    )
    const updated = await this.#required(input.databaseId)
    if (
      updated.connectedInstanceIds.includes(instance.id) !== input.connected
    ) {
      const failure =
        issues.find((issue) => issue.databaseId === database.id) ??
        issues.find((issue) => issue.databaseId === null)
      throw new Error(
        `${failure?.message ?? "Database connection could not be updated"}. Your server was not stopped. Retry the connection from the database page.`
      )
    }
    return updated
  }

  async exportDump(input: RelayDatabaseExport) {
    const database = await this.#required(input.databaseId)
    if (!databaseEngineSupportsLogicalBackups(database.engine)) {
      throw new Error(`${database.engine} dump export is not supported yet`)
    }
    const result = await this.#client(
      requiredContainerId(database),
      databaseClient(database, input.username, input.password, "export"),
      undefined,
      120_000
    )
    if (Buffer.byteLength(result.stdout) > MAX_DUMP_BYTES) {
      throw new Error(
        "The database dump is larger than the current 700 KB transfer limit"
      )
    }
    return {
      content: result.stdout,
      fileName: `${safeFileName(database.name)}-${new Date().toISOString().slice(0, 10)}.sql`,
    }
  }

  async importDump(input: RelayDatabaseDump) {
    const database = await this.#required(input.databaseId)
    if (!databaseEngineSupportsLogicalBackups(database.engine)) {
      throw new Error(`${database.engine} dump import is not supported yet`)
    }
    const custom = input.format === "postgres-custom"
    const dump = custom
      ? Buffer.from(input.content, "base64")
      : Buffer.from(input.content)
    if (dump.byteLength > MAX_DUMP_BYTES) {
      throw new Error(
        "The database dump is larger than the current 700 KB transfer limit"
      )
    }
    if (custom) {
      if (database.engine !== "postgres") {
        throw new Error(
          "PostgreSQL custom-format dumps can only be imported into PostgreSQL"
        )
      }
      if (!dump.subarray(0, 5).equals(POSTGRES_CUSTOM_DUMP_MAGIC)) {
        throw new Error("This isn't a PostgreSQL custom-format dump")
      }
    }
    await this.#client(
      requiredContainerId(database),
      custom
        ? postgresRestoreClient(database, input.username, input.password)
        : databaseClient(database, input.username, input.password, "import"),
      dump,
      120_000
    )
    return { databaseId: database.id, imported: true }
  }

  /** Starts a process in a database's container, streaming its stdio. */
  process(
    database: Pick<RelayManagedDatabase, "containerId">,
    command: ReadonlyArray<string>,
    options: { readonly stdin?: boolean; readonly user?: string } = {}
  ): Promise<DockerExecProcess> {
    return Effect.runPromise(
      this.#engine.execProcess(requiredContainerId(database), command, options)
    )
  }

  // Runs a database client in the database's container, with `input` on its
  // stdin; credentials go through its environment.
  #client(
    container: string,
    client: DatabaseClient,
    input: string | Uint8Array | undefined,
    timeout: number
  ) {
    return Effect.runPromise(
      this.#engine.execWithInput(container, client.command, {
        env: client.env,
        input,
        maxOutputBytes: MAX_DUMP_BYTES + 64 * 1024,
        overflow: "Database transfer exceeded the current size limit",
        timeout,
      })
    )
  }

  async #required(id: string): Promise<RelayManagedDatabase> {
    const database = (await this.#existing()).find(
      (candidate) => candidate.id === id
    )
    if (!database) throw new Error("Database not found")
    return database
  }

  async #labels(id: string): Promise<Record<string, string | undefined>> {
    return (await this.#container(id)).Config.Labels ?? {}
  }

  async #container(id: string): Promise<DatabaseContainerInspect> {
    const container = (await this.#discover()).find(
      (candidate) => candidate.Config.Labels?.["kiln.database.id"] === id
    )
    if (!container) throw new Error("Database not found")
    return container
  }

  async #discover(
    ids?: ReadonlyArray<string>,
    signal?: AbortSignal
  ): Promise<Array<DatabaseContainerInspect>> {
    const engine = this.#engine
    const config = this.#config
    return Effect.runPromise(
      Effect.gen(function* () {
        const listed = yield* engine.listContainers({
          all: true,
          filters: { label: [`${DATABASE_KIND_LABEL}=${DATABASE_KIND}`] },
        })
        return yield* engine.inspectContainers<DatabaseContainerInspect>(
          listed.flatMap((container) =>
            relayOwnsLabels(config, container.Labels) &&
            !container.Names.some((name) => name.includes(REPLACED_MARKER)) &&
            (!ids || ids.includes(container.Labels?.["kiln.database.id"] ?? ""))
              ? [container.Id]
              : []
          )
        )
      }),
      { signal }
    )
  }

  #diskLimits(): Promise<ReadonlyMap<string, number>> {
    return Effect.runPromise(
      this.connections.state.listDiskLimits(DATABASE_KIND)
    )
  }

  // Measures the data volumes in the background when the last measurement
  // is old, so listing never waits on Docker walking every volume.
  #refreshDiskUsage(): void {
    if (
      this.#diskUsageRefresh ||
      Date.now() - this.#diskUsage.measuredAt < DISK_USAGE_REFRESH_MS
    ) {
      return
    }
    // Docker walks every volume, so this is the slow part of reading
    // databases' disk use.
    this.#diskUsageRefresh = Effect.runPromise(
      traceRelayEffect(
        "relay.databases.diskUsage",
        this.#engine.volumeUsage({ timeout: 60_000 })
      ).pipe(
        Effect.map((volumes) => this.#recordDiskUsage(volumes)),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            this.#diskUsageRefresh = null
          })
        )
      )
    )
  }

  #recordDiskUsage(
    volumes: ReadonlyArray<{
      readonly Name: string
      readonly UsageData?: { readonly Size?: number } | null
    }>
  ): void {
    this.#diskUsage = {
      measuredAt: Date.now(),
      sizes: new Map(
        volumes.flatMap((volume) => {
          const size = volume.UsageData?.Size
          return size !== undefined && size >= 0 ? [[volume.Name, size]] : []
        })
      ),
    }
  }

  async #toManagedDatabase(
    container: DatabaseContainerInspect,
    diskLimits: ReadonlyMap<string, number>,
    signal?: AbortSignal
  ): Promise<RelayManagedDatabase> {
    const labels = container.Config.Labels ?? {}
    const id = requiredLabel(labels, "kiln.database.id")
    const engine = databaseEngineSchema.parse(
      requiredLabel(labels, "kiln.database.engine")
    )
    const network = requiredLabel(labels, "kiln.database.network")
    const attached = await this.#attachedContainers(network, signal)
    const connectedInstanceIds = attached.flatMap((candidate) => {
      const instanceId = candidate.Labels?.[this.#config.serverIdLabel]
      return instanceId?.match(/^[a-f0-9]{40}$/iu)
        ? [instanceId.toLowerCase()]
        : []
    })
    const observedState = databaseObservedState(container)
    const status = container.State.Running
      ? container.State.Health?.Status === "starting"
        ? "Initializing"
        : container.State.Health?.Status === "unhealthy"
          ? "Health check failed"
          : "Ready"
      : container.State.Error ||
        (container.State.ExitCode === 0
          ? "Stopped"
          : `Exited with code ${container.State.ExitCode}`)
    return relayManagedDatabaseSchema.parse({
      connectedInstanceIds,
      containerId: container.Id,
      createdAt: requiredLabel(labels, "kiln.database.created-at"),
      databaseName: requiredLabel(labels, "kiln.database.database-name"),
      engine,
      hostname: requiredLabel(labels, "kiln.database.hostname"),
      id,
      image: labels["kiln.database.image"] ?? container.Config.Image,
      internalPort: engineSpecs[engine].internalPort,
      limits: {
        ...containerResourceLimits(container),
        diskBytes: diskLimits.get(id) ?? null,
      },
      diskUsedBytes:
        this.#diskUsage.sizes.get(
          requiredLabel(labels, "kiln.database.volume")
        ) ?? null,
      name: requiredLabel(labels, "kiln.database.name"),
      observedState,
      shortId: id.slice(0, 8),
      status,
      supportsImportExport: databaseEngineSupportsLogicalBackups(engine),
    })
  }

  // Listed containers carry their labels, so none is inspected.
  async #attachedContainers(
    network: string,
    signal?: AbortSignal
  ): Promise<ReadonlyArray<DockerContainerSummary>> {
    return Effect.runPromise(
      this.#engine.listContainers({
        all: true,
        filters: { network: [network] },
      }),
      { signal }
    )
  }

  async #ownedDatabaseResource(
    kind: "network" | "volume",
    databaseId: string,
    suffix: "data" | "network",
    preferredName?: string
  ): Promise<string | null> {
    const fullName = databaseResourceName(this.#config, databaseId, suffix)
    const legacyName = databaseResourceName(
      this.#config,
      databaseId.slice(0, 8),
      suffix
    )
    const candidates = [preferredName, fullName, legacyName].flatMap(
      (name, index, names) =>
        name && names.indexOf(name) === index ? [name] : []
    )
    for (const name of candidates) {
      const inspected = await promiseResult(() =>
        Effect.runPromise<{ readonly Labels: unknown }, unknown>(
          kind === "network"
            ? this.#engine.inspectNetwork(name)
            : this.#engine.inspectVolume(name)
        )
      )
      // Only Docker saying it doesn't exist counts as absent; any other
      // failure fails the lookup, so a delete never reports the database
      // gone while something of it remains.
      if (Result.isFailure(inspected)) {
        if (isDockerNotFound(inspected.failure)) continue
        throw inspected.failure
      }
      const labels = stringLabels(inspected.success.Labels)
      if (
        labels[DATABASE_KIND_LABEL] === DATABASE_KIND &&
        labels["kiln.database.id"] === databaseId &&
        labels[`kiln.database.${kind}`] === name &&
        relayOwnsLabels(this.#config, labels)
      ) {
        return name
      }
    }
    return null
  }
}

function databaseResourceName(
  config: Pick<RelayConfig, "resourceNamespace">,
  id: string,
  suffix: "data" | "database" | "network"
): string {
  const prefix = config.resourceNamespace ? `${config.resourceNamespace}-` : ""
  return `${prefix}kiln-db-${id}-${suffix}`
}

// The private network a database's clients join to reach it.
export function databaseNetworkName(
  config: Pick<RelayConfig, "resourceNamespace">,
  id: string
): string {
  return databaseResourceName(config, id, "network")
}

function databaseHostname(id: string): string {
  return `database-${id}`
}

function requiredContainerId(
  database: Pick<RelayManagedDatabase, "containerId">
): string {
  if (!database.containerId) throw new Error("Database container ID is missing")
  return database.containerId
}

function databaseEnvironment(
  input: RelayCreateDatabase
): Record<string, string> {
  const rootPassword = randomBytes(36).toString("base64url")
  return input.engine === "mysql"
    ? {
        MYSQL_DATABASE: input.databaseName,
        MYSQL_PASSWORD: input.password,
        MYSQL_ROOT_PASSWORD: rootPassword,
        MYSQL_USER: input.username,
      }
    : input.engine === "mariadb"
      ? {
          MARIADB_DATABASE: input.databaseName,
          MARIADB_PASSWORD: input.password,
          MARIADB_ROOT_PASSWORD: rootPassword,
          MARIADB_USER: input.username,
        }
      : input.engine === "postgres"
        ? {
            POSTGRES_DB: input.databaseName,
            POSTGRES_PASSWORD: input.password,
            POSTGRES_USER: input.username,
          }
        : {}
}

// Each check passes only once the database serves its network port. The
// images first initialize on a temporary server that only listens on a local
// socket, and checking that one would report ready before the restart.
// Redis and Valkey answer any connection without a login with NOAUTH, which
// is enough to know they're serving.
//
// Databases are checked twice a second while they start, so they're ready as
// soon as they serve, and every five seconds after the first check passes.
function databaseHealthcheck(engine: DatabaseEngine): ContainerHealthcheck {
  return {
    command:
      engine === "mysql"
        ? "mysqladmin ping -h 127.0.0.1 --silent"
        : engine === "mariadb"
          ? "healthcheck.sh --connect --innodb_initialized"
          : engine === "postgres"
            ? 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
            : `${engine === "redis" ? "redis-cli" : "valkey-cli"} ping | grep -qE '^(PONG|NOAUTH)'`,
    intervalMs: 5_000,
    retries: 24,
    startIntervalMs: 500,
    startPeriodMs: 60_000,
    timeoutMs: 3_000,
  }
}

interface DatabaseClient {
  readonly command: ReadonlyArray<string>
  readonly env: ReadonlyArray<string>
}

function databaseClient(
  database: RelayManagedDatabase,
  username: string,
  password: string,
  mode: "export" | "import"
): DatabaseClient {
  if (database.engine === "mysql") {
    return {
      command: [
        mode === "export" ? "mysqldump" : "mysql",
        "--user",
        username,
        ...(mode === "export"
          ? ["--single-transaction", "--skip-lock-tables", "--no-tablespaces"]
          : []),
        database.databaseName,
      ],
      env: [`MYSQL_PWD=${password}`],
    }
  }
  if (database.engine === "mariadb") {
    return {
      command: [
        mode === "export" ? "mariadb-dump" : "mariadb",
        "--user",
        username,
        ...(mode === "export"
          ? ["--single-transaction", "--skip-lock-tables"]
          : []),
        database.databaseName,
      ],
      env: [`MYSQL_PWD=${password}`],
    }
  }
  return {
    command: [
      mode === "export" ? "pg_dump" : "psql",
      "--username",
      username,
      "--dbname",
      database.databaseName,
      ...(mode === "export"
        ? ["--clean", "--if-exists", "--no-owner"]
        : ["--set", "ON_ERROR_STOP=on"]),
    ],
    env: [`PGPASSWORD=${password}`],
  }
}

// SQL databases are dropped and created again as their administrator, from
// inside the container, the way backup restores reach them. The name comes
// from the container's label, which only allows [a-z0-9_]. Redis and Valkey
// flush everything as the database's own user.
function databaseWipeClient(
  database: RelayManagedDatabase,
  username: string,
  password: string
): DatabaseClient & { input: string } {
  const name = database.databaseName
  if (database.engine === "postgres") {
    return {
      command: [
        "psql",
        "--set",
        "ON_ERROR_STOP=on",
        "--username",
        username,
        "--dbname",
        "postgres",
      ],
      env: [`PGPASSWORD=${password}`],
      input: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\nCREATE DATABASE "${name}";\n`,
    }
  }
  if (database.engine === "mysql" || database.engine === "mariadb") {
    const root =
      database.engine === "mysql"
        ? "MYSQL_ROOT_PASSWORD"
        : "MARIADB_ROOT_PASSWORD"
    const client = database.engine === "mysql" ? "mysql" : "mariadb"
    return {
      command: ["sh", "-ec", `MYSQL_PWD="$${root}" exec ${client} --user=root`],
      env: [],
      input: `DROP DATABASE IF EXISTS \`${name}\`;\nCREATE DATABASE \`${name}\`;\n`,
    }
  }
  return {
    ...keyValueClient(database.engine, username, password, ["FLUSHALL"]),
    input: "",
  }
}

// Redis and Valkey's clients both read the password from REDISCLI_AUTH, and
// exit 0 on an error reply, such as a failed login, unless given -e.
function keyValueClient(
  engine: "redis" | "valkey",
  username: string,
  password: string,
  command: ReadonlyArray<string>
): DatabaseClient {
  return {
    command: [
      engine === "redis" ? "redis-cli" : "valkey-cli",
      "-e",
      "--user",
      username,
      ...command,
    ],
    env: [`REDISCLI_AUTH=${password}`],
  }
}

// What pg_dump -Fc writes first.
const POSTGRES_CUSTOM_DUMP_MAGIC = Buffer.from("PGDMP")

// Restores a custom-format dump from stdin into the database, leaving
// ownership and grants to the database's own user, and stopping at the
// first error, as text imports do.
function postgresRestoreClient(
  database: RelayManagedDatabase,
  username: string,
  password: string
): DatabaseClient {
  return {
    command: [
      "pg_restore",
      "--username",
      username,
      "--dbname",
      database.databaseName,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
    ],
    env: [`PGPASSWORD=${password}`],
  }
}

function databaseAclLoadClient(
  engine: "redis" | "valkey",
  username: string,
  password: string
): DatabaseClient {
  return keyValueClient(engine, username, password, ["ACL", "LOAD"])
}

function rotationSql(
  engine: "mariadb" | "mysql" | "postgres",
  username: string,
  password: string
): string {
  const escapedPassword = password
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "''")
  if (engine === "postgres") {
    return `ALTER USER "${username}" WITH PASSWORD '${escapedPassword}';\n`
  }
  return `ALTER USER '${username}'@'%' IDENTIFIED BY '${escapedPassword}';\n`
}

// Writes the users file Redis and Valkey load into their data volume, with
// the image's own shell in a one-off container.
async function writeAclFile(
  engine: DockerEngine,
  image: string,
  volume: string,
  username: string,
  password: string
) {
  const passwordHash = createHash("sha256").update(password).digest("hex")
  const acl = `user default off\nuser ${username} reset on #${passwordHash} ~* &* +@all\n`
  await Effect.runPromise(
    runWithInput(
      engine,
      {
        command: [
          "-c",
          "cat > /data/users.acl && chown 999:999 /data/users.acl && chmod 600 /data/users.acl",
        ],
        entrypoint: "sh",
        image,
        mounts: [{ source: volume, target: "/data", type: "volume" }],
        name: "",
      },
      acl,
      { maxOutputBytes: MAX_DUMP_BYTES + 64 * 1024, timeout: 60_000 }
    )
  )
}

// Half the start interval of the health check, so a passing check is seen
// soon after it lands. Inspecting a container is a cheap local request.
const READY_POLL_MS = 250

async function waitUntilReady(
  engine: DockerEngine,
  container: string
): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const { State: state } = await Effect.runPromise(
      engine.inspectContainer<DatabaseContainerInspect>(container)
    )
    if (!state.Running) {
      throw new Error(
        state.Error || `Database exited with code ${state.ExitCode}`
      )
    }
    if (!state.Health || state.Health.Status === "healthy") return
    if (state.Health.Status === "unhealthy") {
      throw new Error("Database failed its startup health check")
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  throw new Error("Database did not become ready within 3 minutes")
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
  )
}

function requiredLabel(
  labels: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = labels[name]
  if (!value) throw new Error(`Database recovery label ${name} is missing`)
  return value
}

function stringLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const labels: Record<string, string> = {}
  for (const [name, label] of Object.entries(value)) {
    if (typeof label === "string") labels[name] = label
  }
  return labels
}

function safeFileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "database"
  )
}

// Databases with the state of any still provisioning: one whose container
// exists shows its provisioning until the job finishes, and one without a
// container yet shows its placeholder.
function withProvisioning(
  databases: ReadonlyArray<RelayManagedDatabase>,
  placeholders: ReadonlyMap<string, RelayManagedDatabase>
): Array<RelayManagedDatabase> {
  const pending = new Map(placeholders)
  const listed = databases.map((database) => {
    const placeholder = pending.get(database.id)
    if (!placeholder) return database
    pending.delete(database.id)
    return {
      ...database,
      observedState: placeholder.observedState,
      provisioning: placeholder.provisioning,
      status: placeholder.status,
    }
  })
  return [...listed, ...pending.values()]
}
