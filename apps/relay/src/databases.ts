import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"

import type {
  DatabaseEngine,
  RelayCreateDatabase,
  RelayDatabaseAction,
  RelayDatabaseDump,
  RelayDatabaseExport,
  RelayDatabaseNetwork,
  RelayDeleteDatabase,
  RelayManagedDatabase,
  RelayRotateDatabaseCredentials,
} from "@workspace/contracts"
import {
  databaseEngineSupportsLogicalBackups,
  databaseEngineSchema,
  relayManagedDatabaseSchema,
} from "@workspace/contracts"
import { Effect, Result } from "effect"

import type { DatabaseConnections } from "./database-connections.js"
import { command } from "./command.js"
import type { RelayConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import { relayOwnerLabel, relayOwnsLabels } from "./relay-resources.js"

const DATABASE_KIND_LABEL = "kiln.resource.kind"
const DATABASE_KIND = "database"
const MAX_DUMP_BYTES = 700_000

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
    Image: string
    Labels: Record<string, string | undefined> | null
  }
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

interface AttachedContainerInspect {
  Config: { Labels: Record<string, string | undefined> | null }
  Id: string
  Name: string
}

export function databaseEngineSpec(engine: DatabaseEngine) {
  return {
    ...engineSpecs[engine],
    supportsImportExport: databaseEngineSupportsLogicalBackups(engine),
  }
}

export function databaseRecoveryLabels(
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

export class DatabaseDriver {
  readonly #config: RelayConfig
  readonly #docker: DockerDriver

  constructor(
    config: RelayConfig,
    docker: DockerDriver,
    readonly connections: DatabaseConnections | null = null
  ) {
    this.#config = config
    this.#docker = docker
  }

  async list(): Promise<Array<RelayManagedDatabase>> {
    const containers = await this.#discover()
    return Promise.all(
      containers.map((container) => this.#toManagedDatabase(container))
    )
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

  async create(input: RelayCreateDatabase): Promise<RelayManagedDatabase> {
    if ((await this.list()).some((database) => database.id === input.id)) {
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
      await this.#ensureImage(spec.image)
      await command("docker", [
        "volume",
        "create",
        ...labelArguments(labels),
        volume,
      ])
      volumeCreated = true
      await command("docker", [
        "network",
        "create",
        "--internal",
        ...labelArguments(labels),
        network,
      ])
      networkCreated = true
      if (input.engine === "redis" || input.engine === "valkey") {
        await writeAclFile(spec.image, volume, input.username, input.password)
      }
      await command(
        "docker",
        [
          "create",
          "--name",
          container,
          "--hostname",
          databaseHostname(input.id),
          "--network",
          network,
          "--network-alias",
          databaseHostname(input.id),
          "--restart",
          "unless-stopped",
          "--mount",
          `type=volume,source=${volume},target=${spec.dataMount}`,
          ...labelArguments(labels),
          ...healthArguments(input.engine),
          ...environmentArguments(input),
          spec.image,
          ...(spec.command ?? []),
        ],
        { timeout: 120_000 }
      )
      containerCreated = true
      await command("docker", ["start", container], { timeout: 120_000 })
      await waitUntilReady(container)
      return await this.#required(input.id)
    })
    if (Result.isFailure(created)) {
      if (containerCreated) {
        await ignoreCommand(["rm", "--force", container])
      }
      if (networkCreated) await ignoreCommand(["network", "rm", network])
      if (volumeCreated) await ignoreCommand(["volume", "rm", volume])
      throw created.failure
    }
    return created.success
  }

  async action(input: RelayDatabaseAction): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    const container = requiredContainerId(database)
    if (input.action === "stop") {
      await command("docker", ["stop", "--time", "30", container], {
        timeout: 45_000,
      })
    } else if (input.action === "start") {
      await command("docker", ["start", container], { timeout: 120_000 })
      await waitUntilReady(container)
    } else {
      await command("docker", ["restart", "--time", "30", container], {
        timeout: 150_000,
      })
      await waitUntilReady(container)
    }
    return this.#required(input.databaseId)
  }

  async delete(input: RelayDeleteDatabase) {
    const database = (await this.list()).find(
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
    if (network) {
      const connected = await this.#attachedContainers(network)
      for (const attached of connected) {
        if (attached.Id === container) continue
        await ignoreCommand([
          "network",
          "disconnect",
          "--force",
          network,
          attached.Name.replace(/^\//u, ""),
        ])
      }
    }
    if (container) {
      await command("docker", ["rm", "--force", container], {
        timeout: 90_000,
      })
    }
    if (network) await ignoreCommand(["network", "rm", network])
    await this.connections?.forgetDatabase(input.databaseId)
    if (input.deleteData && volume) {
      await command("docker", ["volume", "rm", volume])
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
        database.image,
        volume,
        input.username,
        input.nextPassword
      )
      const loaded = await promiseResult(() =>
        runProcess(
          "docker",
          databaseAclLoadArguments(
            engine,
            container,
            input.username,
            input.currentPassword
          ),
          undefined,
          60_000
        )
      )
      if (Result.isFailure(loaded)) {
        await writeAclFile(
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
    await runProcess(
      "docker",
      databaseClientArguments(
        database,
        input.username,
        input.currentPassword,
        "import"
      ),
      sql,
      60_000
    )
    return this.#required(input.databaseId)
  }

  async updateNetwork(
    input: RelayDatabaseNetwork
  ): Promise<RelayManagedDatabase> {
    const database = await this.#required(input.databaseId)
    const instance = await this.#docker.findInstance(input.instanceId)
    if (!instance) throw new Error("Server not found on this Relay")
    if (this.connections) {
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
    const labels = await this.#labels(database.id)
    const network = requiredLabel(labels, "kiln.database.network")
    const currentlyConnected = database.connectedInstanceIds.includes(
      input.instanceId
    )
    if (input.connected && !currentlyConnected) {
      await command("docker", ["network", "connect", network, instance.service])
    } else if (!input.connected && currentlyConnected) {
      await command("docker", [
        "network",
        "disconnect",
        network,
        instance.service,
      ])
    }
    return this.#required(input.databaseId)
  }

  async exportDump(input: RelayDatabaseExport) {
    const database = await this.#required(input.databaseId)
    if (!databaseEngineSupportsLogicalBackups(database.engine)) {
      throw new Error(`${database.engine} dump export is not supported yet`)
    }
    const result = await runProcess(
      "docker",
      databaseClientArguments(
        database,
        input.username,
        input.password,
        "export"
      ),
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
    if (Buffer.byteLength(input.content) > MAX_DUMP_BYTES) {
      throw new Error(
        "The database dump is larger than the current 700 KB transfer limit"
      )
    }
    await runProcess(
      "docker",
      databaseClientArguments(
        database,
        input.username,
        input.password,
        "import"
      ),
      input.content,
      120_000
    )
    return { databaseId: database.id, imported: true }
  }

  async #required(id: string): Promise<RelayManagedDatabase> {
    const database = (await this.list()).find(
      (candidate) => candidate.id === id
    )
    if (!database) throw new Error("Database not found")
    return database
  }

  async #labels(id: string): Promise<Record<string, string | undefined>> {
    const container = (await this.#discover()).find(
      (candidate) => candidate.Config.Labels?.["kiln.database.id"] === id
    )
    if (!container) throw new Error("Database not found")
    return container.Config.Labels ?? {}
  }

  async #discover(): Promise<Array<DatabaseContainerInspect>> {
    const result = await command("docker", [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${DATABASE_KIND_LABEL}=${DATABASE_KIND}`,
      "--format",
      "{{.ID}}",
    ])
    const ids = result.stdout.split("\n").filter(Boolean)
    if (ids.length === 0) return []
    const inspected = JSON.parse(
      (await command("docker", ["inspect", ...ids])).stdout
    ) as Array<DatabaseContainerInspect>
    return inspected.filter((container) =>
      relayOwnsLabels(this.#config, container.Config.Labels)
    )
  }

  async #toManagedDatabase(
    container: DatabaseContainerInspect
  ): Promise<RelayManagedDatabase> {
    const labels = container.Config.Labels ?? {}
    const id = requiredLabel(labels, "kiln.database.id")
    const engine = databaseEngineSchema.parse(
      requiredLabel(labels, "kiln.database.engine")
    )
    const network = requiredLabel(labels, "kiln.database.network")
    const attached = await this.#attachedContainers(network)
    const connectedInstanceIds = attached.flatMap((candidate) => {
      const instanceId = candidate.Config.Labels?.[this.#config.serverIdLabel]
      return instanceId?.match(/^[a-f0-9]{40}$/iu)
        ? [instanceId.toLowerCase()]
        : []
    })
    const observedState = container.State.Running
      ? container.State.Health?.Status === "starting"
        ? "starting"
        : container.State.Health?.Status === "unhealthy"
          ? "failed"
          : "running"
      : container.State.ExitCode === 0
        ? "stopped"
        : "failed"
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
      name: requiredLabel(labels, "kiln.database.name"),
      observedState,
      shortId: id.slice(0, 8),
      status,
      supportsImportExport: databaseEngineSupportsLogicalBackups(engine),
    })
  }

  async #attachedContainers(
    network: string
  ): Promise<Array<AttachedContainerInspect>> {
    const result = await command("docker", [
      "container",
      "ls",
      "--all",
      "--filter",
      `network=${network}`,
      "--format",
      "{{.ID}}",
    ])
    const ids = result.stdout.split("\n").filter(Boolean)
    if (ids.length === 0) return []
    return JSON.parse(
      (await command("docker", ["inspect", ...ids])).stdout
    ) as Array<AttachedContainerInspect>
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
        command("docker", [
          kind,
          "inspect",
          "--format",
          "{{json .Labels}}",
          name,
        ])
      )
      if (Result.isFailure(inspected)) continue
      const labels = stringLabels(JSON.parse(inspected.success.stdout))
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

  async #ensureImage(image: string) {
    const inspected = await promiseResult(() =>
      command("docker", ["image", "inspect", image])
    )
    if (Result.isFailure(inspected)) {
      await command("docker", ["pull", image], { timeout: 300_000 })
    }
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

function databaseHostname(id: string): string {
  return `database-${id}`
}

function requiredContainerId(database: RelayManagedDatabase): string {
  if (!database.containerId) throw new Error("Database container ID is missing")
  return database.containerId
}

function labelArguments(
  labels: Readonly<Record<string, string>>
): Array<string> {
  return Object.entries(labels).flatMap(([name, value]) => [
    "--label",
    `${name}=${value}`,
  ])
}

function environmentArguments(input: RelayCreateDatabase): Array<string> {
  const rootPassword = randomBytes(36).toString("base64url")
  const environment =
    input.engine === "mysql"
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
  return Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ])
}

function healthArguments(engine: DatabaseEngine): Array<string> {
  const commandValue =
    engine === "mysql"
      ? "mysqladmin ping -h 127.0.0.1 --silent"
      : engine === "mariadb"
        ? "healthcheck.sh --connect --innodb_initialized"
        : engine === "postgres"
          ? 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
          : "kill -0 1"
  return [
    "--health-cmd",
    commandValue,
    "--health-interval",
    "5s",
    "--health-timeout",
    "3s",
    "--health-retries",
    "24",
    "--health-start-period",
    "10s",
  ]
}

function databaseClientArguments(
  database: RelayManagedDatabase,
  username: string,
  password: string,
  mode: "export" | "import"
): Array<string> {
  const container = database.containerId ?? database.id
  if (database.engine === "mysql") {
    return [
      "exec",
      "-i",
      "-e",
      `MYSQL_PWD=${password}`,
      container,
      mode === "export" ? "mysqldump" : "mysql",
      "--user",
      username,
      ...(mode === "export"
        ? ["--single-transaction", "--skip-lock-tables", "--no-tablespaces"]
        : []),
      database.databaseName,
    ]
  }
  if (database.engine === "mariadb") {
    return [
      "exec",
      "-i",
      "-e",
      `MYSQL_PWD=${password}`,
      container,
      mode === "export" ? "mariadb-dump" : "mariadb",
      "--user",
      username,
      ...(mode === "export"
        ? ["--single-transaction", "--skip-lock-tables"]
        : []),
      database.databaseName,
    ]
  }
  return [
    "exec",
    "-i",
    "-e",
    `PGPASSWORD=${password}`,
    container,
    mode === "export" ? "pg_dump" : "psql",
    "--username",
    username,
    "--dbname",
    database.databaseName,
    ...(mode === "export"
      ? ["--clean", "--if-exists", "--no-owner"]
      : ["--set", "ON_ERROR_STOP=on"]),
  ]
}

export function databaseAclLoadArguments(
  engine: "redis" | "valkey",
  container: string,
  username: string,
  password: string
): Array<string> {
  return [
    "exec",
    "-e",
    `${engine === "redis" ? "REDISCLI_AUTH" : "VALKEYCLI_AUTH"}=${password}`,
    container,
    engine === "redis" ? "redis-cli" : "valkey-cli",
    "--user",
    username,
    "ACL",
    "LOAD",
  ]
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

async function writeAclFile(
  image: string,
  volume: string,
  username: string,
  password: string
) {
  const passwordHash = createHash("sha256").update(password).digest("hex")
  const acl = `user default off\nuser ${username} reset on #${passwordHash} ~* &* +@all\n`
  await runProcess(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--mount",
      `type=volume,source=${volume},target=/data`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      "cat > /data/users.acl && chown 999:999 /data/users.acl && chmod 600 /data/users.acl",
    ],
    acl,
    60_000
  )
}

async function waitUntilReady(container: string): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const result = await command("docker", [
      "inspect",
      "--format",
      "{{json .State}}",
      container,
    ])
    const state = JSON.parse(result.stdout) as DatabaseContainerInspect["State"]
    if (!state.Running) {
      throw new Error(
        state.Error || `Database exited with code ${state.ExitCode}`
      )
    }
    if (!state.Health || state.Health.Status === "healthy") return
    if (state.Health.Status === "unhealthy") {
      throw new Error("Database failed its startup health check")
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error("Database did not become ready within 3 minutes")
}

async function ignoreCommand(arguments_: Array<string>): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => command("docker", arguments_),
      catch: (cause) => cause,
    }).pipe(Effect.ignore)
  )
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

function runProcess(
  executable: string,
  arguments_: ReadonlyArray<string>,
  input: string | undefined,
  timeoutMs: number
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let outputBytes = 0
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${executable} timed out`))
    }, timeoutMs)
    const collect = (target: Array<Buffer>) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_DUMP_BYTES + 64 * 1024) {
        child.kill("SIGKILL")
        reject(new Error("Database transfer exceeded the current size limit"))
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      const result = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }
      if (code === 0) resolve(result)
      else
        reject(
          new Error(
            result.stderr.trim() || `${executable} exited with code ${code}`
          )
        )
    })
    child.stdin.end(input)
  })
}
