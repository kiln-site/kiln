/**
 * Databases opened to the internet.
 *
 * A public database keeps its private network and its clients there. Its
 * public port is held by a gate, a container of its own from the Relay's
 * image (database-gate/), on that network and one of its own that publishes
 * the port. The gate refuses a client that doesn't ask for TLS and ends TLS
 * itself, with the certificate the Relay's Traefik got for the name the
 * client asked for, each name having its own, then passes the connection on
 * to the database on its private network. The keys stay in the gate, which
 * the Relay keeps; the database never has them.
 *
 * Opening one waits for a certificate for one of its names, then starts the
 * gate. MySQL and MariaDB take a password only on a connection they see as
 * secure, so they're deployed again first with a certificate the Relay makes
 * for them (one restart), and their root login is kept to their own
 * container. A renewed certificate, or one for a name added since, is
 * written into the gate, which reads it again. Closing one removes its gate,
 * then forgets it.
 */
import "reflect-metadata"

import { createHash, randomBytes, webcrypto } from "node:crypto"
import { Readable } from "node:stream"

import { X509CertificateGenerator } from "@peculiar/x509"
import type {
  DatabaseEngine,
  RelayDatabasePublic,
  RelayPendingCertificate,
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
const GATE_VERSION = "2"
const GATE_LABEL = "kiln.database.gate"
const GATE_VERSION_LABEL = "kiln.database.gate-version"
const GATE_PORT_LABEL = "kiln.database.gate-port"
// Where the gate reads its names' certificates, each chain then its key, in
// a volume of its own: its container's filesystem is read-only.
const GATE_CERTIFICATES = "/kiln-certificates"
const GATE_CERTIFICATES_FILE = "certificates.pem"
// The user the gate runs as, which must be able to read them.
const GATE_USER = 65_534

// Who MySQL's and MariaDB's official images run their server as, which
// must own its key.
const engineUsers: Partial<Record<DatabaseEngine, string>> = {
  mariadb: "mysql",
  mysql: "mysql",
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
  // When the first of each one's certificates runs out, as last given.
  readonly #expires = new Map<string, string>()
  // What each gate's certificates file holds, by its SHA-256, as last
  // written; none after the Relay starts, so each is written once again.
  readonly #written = new Map<string, string>()
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
   * ask for each of its names' certificates, and opens it once one comes.
   * Closing removes its gate before it forgets it, so a close that fails
   * leaves it public and still kept, never reachable while forgotten.
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
    const served = await this.#served(saved)
    // Never open without TLS: the gate waits for a certificate.
    if (served.length === 0) {
      await this.#removeGate(id)
      return
    }
    const database = await databases.target(id)
    if (ownTls(database.engine) && !(await databases.hasPublicTls(id))) {
      await databases.redeployForPublic(id)
    }
    this.#expires.set(
      id,
      new Date(
        Math.min(...served.map(({ expiresAt }) => expiresAt))
      ).toISOString()
    )
    if (!saved.rootLocal) {
      if (!(await databases.keepRootLocal(id))) return
      await Effect.runPromise(state.markDatabaseRootLocal(id))
    }
    await this.load()
    await this.#ensureGate(id, saved.port, await databases.target(id), served)
  }

  /**
   * What a public MySQL or MariaDB database's container gets for TLS, which
   * its gate's connections use; null for other engines, and while it's
   * private. DatabaseDriver asks as it deploys one.
   */
  async tls(databaseId: string): Promise<DatabaseTls | null> {
    const saved = this.#saved.get(databaseId)
    if (!saved || !this.#options.proxy.runsTraefik) return null
    const { engine } = await this.#options.databases.target(databaseId)
    if (!ownTls(engine)) return null
    return {
      fill: (container) => this.#fill(container, engine, databaseId),
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
    // Open at the names it has certificates for while one for a new name
    // comes; each name's row says where its own stands.
    if (this.#open.has(database.id)) {
      return { ...base, error: null, state: "open" }
    }
    // It opens with its first certificate, so it says where the name
    // nearest one stands.
    const names = new Set(saved.hostnames)
    const nearness = (pending: RelayPendingCertificate) =>
      pending.waitingFor === "dns" ? 2 : pending.failed ? 1 : 0
    const pending = this.#options.certificates
      .pending()
      .filter(({ hostname }) => names.has(hostname))
      .sort((left, right) => nearness(left) - nearness(right))[0]
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
   * Forgets a deleted database: its gate, its TLS volume, and that it was
   * public. The caller holds the database's lane, after the
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
  // seeing it taken.
  #remember(databaseId: string, value: RelayDatabasePublic | null): void {
    const saved = new Map(this.#saved)
    if (value === null) {
      saved.delete(databaseId)
    } else {
      const before = saved.get(databaseId)
      saved.set(databaseId, {
        databaseId,
        hostnames: value.hostnames,
        port: value.port,
        rootLocal: before?.rootLocal ?? false,
      })
    }
    this.#saved = saved
  }

  // Each of its names' certificates, its first name's first, each once: a
  // client that names none gets the first.
  async #served(
    saved: RelayStoredDatabasePublic
  ): Promise<Array<HeldCertificate>> {
    const served: Array<HeldCertificate> = []
    for (const held of await this.#options.certificates.certificates(
      saved.hostnames
    )) {
      if (held && !served.some(({ chain }) => chain === held.chain)) {
        served.push(held)
      }
    }
    return served
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

  // Writes a certificate the Relay makes for the database, and its key,
  // into its container, owned by the user its server runs as. Its gate
  // checks no name, so a new one each time it's deployed serves.
  async #fill(
    container: string,
    engine: DatabaseEngine,
    databaseId: string
  ): Promise<void> {
    const user = engineUsers[engine]
    if (!user) return
    const { uid, gid } = await this.#user(container, user)
    const own = await selfSigned(
      databaseMemberAliases({ id: databaseId, kind: "database" })[0] ??
        databaseId
    )
    const archive = tarPack()
    archive.entry({ gid, mode: 0o644, name: "server.crt", uid }, own.chain)
    archive.entry({ gid, mode: 0o600, name: "server.key", uid }, own.key)
    archive.finalize()
    await Effect.runPromise(
      this.#options.engine.putContainerArchive(
        container,
        TLS_FOLDER,
        Readable.from(archive)
      )
    )
  }

  // Writes its names' certificates into its gate, which reads them again
  // when they change, unless they're what it has.
  async #writeCertificates(
    databaseId: string,
    served: ReadonlyArray<HeldCertificate>
  ): Promise<void> {
    const file = served
      .map(({ chain, key }) => `${chain.trim()}\n${key.trim()}\n`)
      .join("")
    const written = createHash("sha256").update(file).digest("hex")
    if (this.#written.get(databaseId) === written) return
    const archive = tarPack()
    archive.entry(
      {
        gid: GATE_USER,
        mode: 0o400,
        name: GATE_CERTIFICATES_FILE,
        uid: GATE_USER,
      },
      file
    )
    archive.finalize()
    await Effect.runPromise(
      this.#options.engine.putContainerArchive(
        this.#name(databaseId, "public"),
        GATE_CERTIFICATES,
        Readable.from(archive)
      )
    )
    this.#written.set(databaseId, written)
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
    database: RelayManagedDatabase,
    served: ReadonlyArray<HeldCertificate>
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
      await this.#writeCertificates(databaseId, served)
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
        engine.createVolume({
          labels: networkLabels,
          name: this.#name(databaseId, "certificates"),
        })
      )
      await Effect.runPromise(
        createContainer(engine, {
          capDrop: ["ALL"],
          command: [
            "-protocol",
            gateProtocols[database.engine],
            "-listen",
            `:${GATE_PORT}`,
            "-target",
            `${databaseMemberAliases({ id: databaseId, kind: "database" })[0]}:${database.internalPort}`,
            "-certificates",
            `${GATE_CERTIFICATES}/${GATE_CERTIFICATES_FILE}`,
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
          mounts: [
            {
              source: this.#name(databaseId, "certificates"),
              target: GATE_CERTIFICATES,
              type: "volume",
            },
          ],
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
      await this.#writeCertificates(databaseId, served)
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
    this.#written.delete(databaseId)
    await Effect.runPromise(
      engine
        .removeContainer(this.#name(databaseId, "public"), { force: true })
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
    )
    // Its keys go with it.
    await Effect.runPromise(
      engine
        .removeVolume(this.#name(databaseId, "certificates"))
        .pipe(Effect.ignore)
    )
    await Effect.runPromise(
      engine
        .removeNetwork(this.#name(databaseId, "public-network"))
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
    )
  }

  #name(
    databaseId: string,
    suffix: "certificates" | "public" | "public-network" | "tls"
  ) {
    return this.#keyed(physicalKey(databaseId), suffix)
  }

  #keyed(
    key: string,
    suffix: "certificates" | "public" | "public-network" | "tls"
  ) {
    const prefix = this.#options.config.resourceNamespace
      ? `${this.#options.config.resourceNamespace}-`
      : ""
    return `${prefix}kiln-db-${key}-${suffix}`
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
        if (key) {
          await Effect.runPromise(
            engine
              .removeVolume(this.#keyed(key, "certificates"))
              .pipe(Effect.ignore)
          )
        }
      }
    }
  }
}

// MySQL and MariaDB run with TLS of their own for their gate.
function ownTls(engine: DatabaseEngine): boolean {
  return engine === "mysql" || engine === "mariadb"
}

// A certificate the Relay makes for a database's own TLS, for ten years:
// its gate checks no name or date, as it reaches it on its private network.
async function selfSigned(
  name: string
): Promise<{ readonly chain: string; readonly key: string }> {
  const keys = (await webcrypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  )) as webcrypto.CryptoKeyPair
  const now = Date.now()
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      keys,
      name: `CN=${name}`,
      notAfter: new Date(now + 10 * 365 * 24 * 60 * 60_000),
      notBefore: new Date(now - 5 * 60_000),
      serialNumber: `01${randomBytes(15).toString("hex")}`,
      signingAlgorithm: { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    },
    webcrypto
  )
  const key = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)
  ).toString("base64")
  return {
    chain: certificate.toString("pem"),
    key: `-----BEGIN PRIVATE KEY-----\n${key.match(/.{1,64}/gu)?.join("\n") ?? key}\n-----END PRIVATE KEY-----\n`,
  }
}
