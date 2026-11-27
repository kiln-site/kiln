/**
 * Databases opened to the internet.
 *
 * A public database keeps its private network and its clients there. Its
 * public port is held by a gate, a container of its own from the Relay's
 * image (database-gate/), on that network and one of its own that publishes
 * the port. The gate refuses a client that doesn't ask for TLS and passes
 * everything else through untouched: TLS ends in the database, which runs
 * with the certificate the Relay's Traefik got for its public names.
 *
 * Opening one waits for one certificate for all its names, then deploys the
 * database again with it (one restart), keeps MySQL's and MariaDB's root
 * login to their own container, and starts the gate last. A renewed
 * certificate, or one for names added since, is written over the old one
 * and reloaded; until it comes, the old one keeps the database open. Closing one removes its gate, then
 * forgets it; the database keeps TLS on until it's next deployed.
 */
import { createHash, X509Certificate } from "node:crypto"
import { Readable } from "node:stream"
import { rootCertificates } from "node:tls"

import type {
  DatabaseEngine,
  RelayDatabasePublic,
  RelayDatabasePublicStatus,
  RelayManagedDatabase,
} from "@workspace/contracts"
import { Effect } from "effect"
import { pack as tarPack } from "tar-stream"

import { helpersInDevelopment, relayContainer } from "./backups/tar-archives.js"
import type { RelayConfig } from "./config.js"
import {
  ensuringPromise,
  promiseEffect,
  tapPromiseError,
} from "./effect/promise.js"
import {
  databaseTlsPort,
  TLS_FOLDER,
  type DatabaseDriver,
  type DatabaseTls,
} from "./databases.js"
import { databaseMemberAliases } from "./database-connections.js"
import { createContainer } from "./docker-container-spec.js"
import { isDockerNotFound, type DockerEngine } from "./docker-engine.js"
import type {
  RelayStateStore,
  RelayStoredDatabasePublic,
} from "./effect/state.js"
import type { HostPorts } from "./host-ports.js"
import { physicalKey } from "./instance-keys.js"
import { relayOwnerLabels, relayOwnsLabels } from "./relay-resources.js"
import type {
  DatabaseCertificateName,
  HeldCertificate,
  WebCertificates,
} from "./web-certificates.js"

/** The port the gate listens on in its container, whatever it publishes. */
const GATE_PORT = 5432
/**
 * Raised when the gate's program or how it runs changes, so each running
 * gate is replaced once; a Relay update alone leaves gates running.
 */
const GATE_VERSION = "1"
const GATE_LABEL = "kiln.database.gate"
const GATE_VERSION_LABEL = "kiln.database.gate-version"
const GATE_PORT_LABEL = "kiln.database.gate-port"

// Who each official image's server runs as, which must own its key.
const engineUsers: Record<DatabaseEngine, string> = {
  mariadb: "mysql",
  mysql: "mysql",
  postgres: "postgres",
  redis: "redis",
  valkey: "valkey",
}

// What the gate tells TLS apart in, by engine.
const gateProtocols: Record<DatabaseEngine, "mysql" | "postgres" | "tls"> = {
  mariadb: "mysql",
  mysql: "mysql",
  postgres: "postgres",
  redis: "tls",
  valkey: "tls",
}

export interface PublicDatabaseOptions {
  readonly certificates: WebCertificates
  readonly config: RelayConfig
  readonly databases: DatabaseDriver
  readonly engine: DockerEngine
  readonly hostPorts: HostPorts
  readonly proxy: { readonly runsTraefik: boolean }
  readonly state: RelayStateStore["Service"]
}

export class PublicDatabases {
  readonly #options: PublicDatabaseOptions
  #saved = new Map<string, RelayStoredDatabasePublic>()
  // Why each database couldn't open, from its last attempt.
  readonly #errors = new Map<string, string>()
  // Databases whose gate was running at their last check.
  readonly #open = new Set<string>()
  // When each one's certificate runs out, as last given.
  readonly #expires = new Map<string, string>()
  // Ports being given to databases whose writes haven't saved yet; writes
  // for different databases run at once.
  readonly #claiming = new Map<string, number>()
  #wake: (() => void) | null = null

  constructor(options: PublicDatabaseOptions) {
    this.#options = options
  }

  /** Reads which databases are public, as the Relay starts. */
  async load(): Promise<void> {
    const saved = await Effect.runPromise(
      this.#options.state.listDatabasePublic()
    )
    this.#saved = new Map(saved.map((row) => [row.databaseId, row]))
  }

  /** The databases that are public, for the loop that keeps them open. */
  ids(): ReadonlyArray<string> {
    return [...this.#saved.keys()]
  }

  /** Public names, for Traefik to ask for their certificates. */
  names(): ReadonlyArray<DatabaseCertificateName> {
    return [...this.#saved.values()].map(({ databaseId, hostnames }) => ({
      databaseId,
      hostnames,
    }))
  }

  /** Has the loop look again now, as when a certificate may have come. */
  nudge(): void {
    if (this.#saved.size > 0) this.#wake?.()
  }

  /** Resolves when a database is opened or closed. */
  woken(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = () => {
        this.#wake = null
        resolve()
      }
    })
  }

  /**
   * Opens a database at its names and a port, changes them, or closes it.
   * The caller holds the database's lane. Saving it is the one change made
   * here, so a write that fails changed nothing; the loop then has Traefik
   * ask for a certificate for its names, and opens it once that comes. Closing removes its
   * gate before it forgets it, so a close that fails leaves it public and
   * still kept, never reachable while forgotten.
   */
  async write(
    databaseId: string,
    value: RelayDatabasePublic | null
  ): Promise<void> {
    const { proxy, state } = this.#options
    if (value) {
      if (!proxy.runsTraefik) {
        throw new Error(
          "This Relay doesn't run Kiln's Traefik, which gets a public database's certificate"
        )
      }
      await this.#options.databases.target(databaseId)
      await this.#portFree(databaseId, value.port)
      // Checked and held with nothing awaited between, so two writes can't
      // both take a port; held until it's saved.
      this.#portUnclaimed(databaseId, value.port)
      this.#claiming.set(databaseId, value.port)
    } else {
      await this.#removeGate(databaseId)
    }
    await ensuringPromise(
      async () => {
        await Effect.runPromise(state.setDatabasePublic(databaseId, value))
        this.#remember(databaseId, value)
      },
      () => this.#claiming.delete(databaseId)
    )
    // At another port or name, it isn't open there until its gate is made
    // again, which the loop does now.
    this.#open.delete(databaseId)
    this.#errors.delete(databaseId)
    this.#wake?.()
  }

  /**
   * Brings a database to where it should be: open once its certificate is
   * there, its gate gone otherwise. The caller holds the database's lane.
   */
  async reconcile(databaseId: string): Promise<void> {
    const saved = this.#saved.get(databaseId)
    if (!saved || !this.#options.proxy.runsTraefik) {
      await this.#removeGate(databaseId)
      return
    }
    // One deleted while its Relay was down, or whose delete stopped before
    // forgetting it, is forgotten now.
    if (!(await this.#options.databases.exists(databaseId))) {
      await this.forget(databaseId)
      return
    }
    await tapPromiseError(
      () => this.#bringOpen(saved),
      (cause) =>
        this.#errors.set(
          databaseId,
          (cause instanceof Error ? cause.message : String(cause)).slice(0, 280)
        )
    )
    this.#errors.delete(databaseId)
  }

  async #bringOpen(saved: RelayStoredDatabasePublic): Promise<void> {
    const { databases, state } = this.#options
    const id = saved.databaseId
    const held = await this.#held(saved)
    // Never open without TLS: the gate waits for the certificate.
    if (!held) {
      await this.#removeGate(id)
      return
    }
    const fingerprint = createHash("sha256").update(held.chain).digest("hex")
    if (!(await databases.hasPublicTls(id))) {
      await databases.redeployForPublic(id)
      await Effect.runPromise(
        state.markDatabasePublic(id, { certificate: fingerprint })
      )
    } else if (saved.certificate !== fingerprint) {
      const database = await databases.target(id)
      if (database.containerId) {
        await this.#fill(database.containerId, database.engine, held)
        await databases.reloadPublicTls(id)
      }
      await Effect.runPromise(
        state.markDatabasePublic(id, { certificate: fingerprint })
      )
    }
    this.#expires.set(id, expiry(held))
    if (!saved.rootLocal) {
      if (!(await databases.keepRootLocal(id))) return
      await Effect.runPromise(state.markDatabasePublic(id, { rootLocal: true }))
    }
    await this.load()
    await this.#ensureGate(id, saved.port, await databases.target(id))
  }

  /**
   * What a public database's container gets for TLS, once its certificate
   * is there; null otherwise. DatabaseDriver asks as it deploys one.
   */
  async tls(databaseId: string): Promise<DatabaseTls | null> {
    const saved = this.#saved.get(databaseId)
    if (!saved || !this.#options.proxy.runsTraefik) return null
    const held = await this.#held(saved)
    if (!held) return null
    const { engine } = await this.#options.databases.target(databaseId)
    return {
      fill: (container) => this.#fill(container, engine, held),
      volume: this.#name(databaseId, "tls"),
    }
  }

  /** Where opening a database stands, for the Relay's snapshot. */
  status(
    database: Pick<RelayManagedDatabase, "id">
  ): RelayDatabasePublicStatus | null {
    const saved = this.#saved.get(database.id)
    if (!saved) return null
    const base = {
      certificateExpiresAt: this.#expires.get(database.id) ?? null,
      hostnames: [...saved.hostnames],
      port: saved.port,
    }
    if (!this.#options.proxy.runsTraefik) {
      return {
        ...base,
        error:
          "This Relay doesn't run Kiln's Traefik, which gets a public database's certificate",
        state: "failed",
      }
    }
    const error = this.#errors.get(database.id)
    if (error) return { ...base, error, state: "failed" }
    // Open at the names its certificate has while one for a new name comes;
    // each name's row says where its own stands.
    if (this.#open.has(database.id)) {
      return { ...base, error: null, state: "open" }
    }
    const names = new Set(saved.hostnames)
    const pending = this.#options.certificates
      .pending()
      .filter(({ hostname }) => names.has(hostname))
      .sort(
        (left, right) =>
          Number(right.waitingFor === "dns") -
            Number(left.waitingFor === "dns") ||
          Number(right.failed) - Number(left.failed)
      )[0]
    if (pending?.waitingFor === "dns") {
      return { ...base, error: null, state: "waiting_for_dns" }
    }
    if (pending?.failed) {
      return {
        ...base,
        error:
          "Let's Encrypt hasn't issued its certificate. Check that the name points at this Relay and that port 80 reaches it.",
        state: "failed",
      }
    }
    if (pending) return { ...base, error: null, state: "getting_certificate" }
    return {
      ...base,
      error: null,
      state: "opening",
    }
  }

  /** The container whose output is the gate's log, or null. */
  gateContainer(databaseId: string): string | null {
    return this.#saved.has(databaseId) ? this.#name(databaseId, "public") : null
  }

  /**
   * Forgets a deleted database: its gate, its certificate's volume, and
   * that it was public. The caller holds the database's lane, after the
   * database's container is gone; Traefik stops asking for its name on the
   * next pass, which holds the routes.
   */
  async forget(databaseId: string): Promise<void> {
    await this.#removeGate(databaseId)
    if (this.#saved.has(databaseId)) {
      await Effect.runPromise(
        this.#options.state.setDatabasePublic(databaseId, null)
      )
      this.#remember(databaseId, null)
      this.#wake?.()
    }
    this.#errors.delete(databaseId)
    this.#expires.delete(databaseId)
    await Effect.runPromise(
      this.#options.engine
        .removeVolume(this.#name(databaseId, "tls"))
        .pipe(Effect.ignore)
    )
  }

  // A port another container on the host has, which its gate would fail to
  // publish, or another public database waiting for its certificate was
  // given. Its own gate's doesn't count.
  async #portFree(databaseId: string, port: number): Promise<void> {
    this.#portUnclaimed(databaseId, port)
    const gate = this.#name(databaseId, "public")
    const release = await this.#options.hostPorts.claim(
      [{ port, protocol: "tcp" }],
      (container) => container.Names.some((name) => name === `/${gate}`)
    )
    release()
  }

  // What was just saved, as setDatabasePublic saves it, without reading it
  // back: nothing that can fail comes between saving a port and others
  // seeing it taken. The certificate it has stays named, as the one its
  // database serves until one for its new names comes.
  #remember(databaseId: string, value: RelayDatabasePublic | null): void {
    const saved = new Map(this.#saved)
    if (value === null) {
      saved.delete(databaseId)
    } else {
      const before = saved.get(databaseId)
      saved.set(databaseId, {
        certificate: before?.certificate ?? null,
        databaseId,
        hostnames: value.hostnames,
        port: value.port,
        rootLocal: before?.rootLocal ?? false,
      })
    }
    this.#saved = saved
  }

  // The certificate for all its names, or, until that comes, the one it
  // was last given, so a name added to an open database keeps it open at
  // the others.
  async #held(
    saved: RelayStoredDatabasePublic
  ): Promise<HeldCertificate | null> {
    const { certificates } = this.#options
    return (
      (await certificates.certificate(saved.hostnames)) ??
      (saved.certificate
        ? await certificates.certificateWithFingerprint(saved.certificate)
        : null)
    )
  }

  #portUnclaimed(databaseId: string, port: number): void {
    const others = [
      ...[...this.#saved.values()].map((row) => [row.databaseId, row.port]),
      ...this.#claiming,
    ] as const
    if (others.some(([id, taken]) => id !== databaseId && taken === port)) {
      throw new Error(`Another public database has port ${port}`)
    }
  }

  // Writes the certificate, its chain and its key into the database's
  // container, owned by the user its server runs as.
  async #fill(
    container: string,
    engine: DatabaseEngine,
    held: HeldCertificate
  ): Promise<void> {
    const { uid, gid } = await this.#user(container, engineUsers[engine])
    const archive = tarPack()
    const entry = (name: string, body: string, mode: number) =>
      archive.entry({ gid, mode, name, uid }, body)
    entry("server.crt", held.chain, 0o644)
    entry("server.key", held.key, 0o600)
    entry("ca.crt", issuers(held.chain), 0o644)
    archive.finalize()
    await Effect.runPromise(
      this.#options.engine.putContainerArchive(
        container,
        TLS_FOLDER,
        Readable.from(archive)
      )
    )
  }

  // A user's IDs, from the container's own /etc/passwd.
  async #user(
    container: string,
    user: string
  ): Promise<{ uid: number; gid: number }> {
    const file = await Effect.runPromise(
      this.#options.engine.readContainerFile(container, "/etc/passwd", 256_000)
    )
    for (const line of file?.bytes.toString("utf8").split("\n") ?? []) {
      const [name, , uid, gid] = line.split(":")
      if (name === user && uid !== undefined && gid !== undefined) {
        return { gid: Number(gid), uid: Number(uid) }
      }
    }
    throw new Error(`The database's image has no ${user} user to give TLS to`)
  }

  async #ensureGate(
    databaseId: string,
    port: number,
    database: RelayManagedDatabase
  ): Promise<void> {
    const { config, engine, hostPorts } = this.#options
    const name = this.#name(databaseId, "public")
    const network = this.#name(databaseId, "public-network")
    const target = await this.#options.databases.network(databaseId)
    const existing = await Effect.runPromise(
      engine
        .inspectContainer<{
          Config: { Labels: Record<string, string> | null }
          NetworkSettings: { Networks: Record<string, unknown> | null }
          State: { Running: boolean }
        }>(name)
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.succeed(null)))
    )
    const labels = existing?.Config.Labels ?? {}
    const networks = Object.keys(existing?.NetworkSettings.Networks ?? {})
    // One made but never joined to both networks, as when its Relay stopped
    // partway, is made again.
    if (
      existing &&
      labels[GATE_VERSION_LABEL] === GATE_VERSION &&
      labels[GATE_PORT_LABEL] === String(port) &&
      networks.includes(network) &&
      networks.includes(target)
    ) {
      if (!existing.State.Running) {
        await Effect.runPromise(engine.startContainer(name))
      }
      this.#open.add(databaseId)
      return
    }
    await this.#removeGate(databaseId)
    const relay = await relayContainer(config, engine)
    const ownerLabels = relayOwnerLabels(config)
    // With IPv6, so an IPv6 client reaches the gate as itself, not through
    // Docker's proxy from the network's gateway; without it on a host whose
    // Docker can't.
    const networkLabels = {
      [GATE_LABEL]: physicalKey(databaseId),
      ...ownerLabels,
    }
    await Effect.runPromise(
      engine
        .createNetwork({ ipv6: true, labels: networkLabels, name: network })
        .pipe(
          Effect.catch(() =>
            engine.createNetwork({ labels: networkLabels, name: network })
          ),
          Effect.ignore
        )
    )
    const release = await hostPorts.claim([{ port, protocol: "tcp" }])
    const development = helpersInDevelopment()
    const made = async () => {
      await Effect.runPromise(
        createContainer(engine, {
          capDrop: ["ALL"],
          command: [
            "-protocol",
            gateProtocols[database.engine],
            "-listen",
            `:${GATE_PORT}`,
            "-target",
            `${databaseMemberAliases({ id: databaseId, kind: "database" })[0]}:${databaseTlsPort(database.engine, database.internalPort)}`,
          ],
          entrypoint: config.databaseGatePath,
          healthcheck: "none",
          image: relay.Image,
          // Each connection is a line; the internet's are many, so they're
          // kept to a few megabytes whatever the host's Docker keeps.
          logConfig: {
            config: { "max-file": "3", "max-size": "10m" },
            type: "json-file",
          },
          labels: {
            [GATE_LABEL]: physicalKey(databaseId),
            [GATE_PORT_LABEL]: String(port),
            [GATE_VERSION_LABEL]: GATE_VERSION,
            ...ownerLabels,
          },
          memory: "64m",
          name,
          network: { name: network },
          pidsLimit: 64,
          ports: [
            { containerPort: GATE_PORT, hostPort: port, protocol: "tcp" },
          ],
          readOnly: true,
          restart: "unless-stopped",
          securityOpt: ["no-new-privileges"],
          user: "65534:65534",
          // In development the gate is built into a volume the Relay's
          // container has, as its other tools are.
          ...(development && { volumesFrom: [relay.Id] }),
        })
      )
      await Effect.runPromise(engine.connectNetwork(target, name, {}))
      await Effect.runPromise(engine.startContainer(name))
    }
    // The port is the gate's once it's made, or free again if it isn't; a
    // gate made only partway goes again.
    await Effect.runPromise(
      promiseEffect(made).pipe(
        Effect.tapError(() =>
          promiseEffect(() => this.#removeGate(databaseId)).pipe(Effect.ignore)
        ),
        Effect.ensuring(Effect.sync(release))
      )
    )
    this.#open.add(databaseId)
  }

  async #removeGate(databaseId: string): Promise<void> {
    const { engine } = this.#options
    this.#open.delete(databaseId)
    await Effect.runPromise(
      engine
        .removeContainer(this.#name(databaseId, "public"), { force: true })
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
    )
    await Effect.runPromise(
      engine
        .removeNetwork(this.#name(databaseId, "public-network"))
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
    )
  }

  #name(databaseId: string, suffix: "public" | "public-network" | "tls") {
    const prefix = this.#options.config.resourceNamespace
      ? `${this.#options.config.resourceNamespace}-`
      : ""
    return `${prefix}kiln-db-${physicalKey(databaseId)}-${suffix}`
  }

  /** Gates whose database is gone or private, for the Relay's start. */
  async removeStrayGates(): Promise<void> {
    const { config, engine } = this.#options
    const containers = await Effect.runPromise(
      engine.listContainers({ all: true, filters: { label: [GATE_LABEL] } })
    )
    for (const container of containers) {
      if (!relayOwnsLabels(config, container.Labels)) continue
      const key = container.Labels?.[GATE_LABEL]
      const kept = [...this.#saved.keys()].some((id) => physicalKey(id) === key)
      if (!kept) {
        await Effect.runPromise(
          engine
            .removeContainer(container.Id, { force: true })
            .pipe(Effect.ignore)
        )
      }
    }
  }
}

// The issuers of a certificate chain, its leaf left out, ending with the root
// that signed the last one: MySQL checks a certificate against the whole
// chain in its CA file before it reloads one. The root comes from Node's
// own store, which Let's Encrypt's roots are in.
function issuers(chain: string): string {
  const certificates = chain.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu
  )
  if (!certificates || certificates.length === 0) return chain
  const intermediates = certificates.slice(1)
  const last = new X509Certificate(certificates[certificates.length - 1] ?? "")
  const root = rootCertificates.find((candidate) => {
    const authority = new X509Certificate(candidate)
    return authority.subject === last.issuer && last.checkIssued(authority)
  })
  return [...intermediates, ...(root ? [root] : [])].join("\n") + "\n"
}

// When a certificate runs out, as an ISO date.
function expiry(held: HeldCertificate): string {
  return new Date(new X509Certificate(held.chain).validTo).toISOString()
}
