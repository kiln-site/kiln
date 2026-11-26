/**
 * Certificates for the web routes the bundled Traefik serves.
 *
 * Traefik asks Let's Encrypt for a missing certificate only when its
 * configuration changes. Asked before a new name resolves, it gets NXDOMAIN
 * and doesn't ask again. So Traefik asks for a hostname only once its name
 * resolves at its zone's own nameservers, and someone can have it ask again
 * by hand; that reaches every certificate it lacks, so it's limited per
 * Relay. A name being moved here resolves already, to where it's moved from,
 * so it's held until it's said to point here, and asked for a little after:
 * a changed record takes a while to reach everyone, and a proxied one's proxy
 * longer, so it's asked for again a few times while it's missing.
 */
import { promises as dns } from "node:dns"
import { readFile, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { join } from "node:path"

import {
  webRouteHostnames,
  type RelayPendingCertificate,
} from "@workspace/contracts"
import { Predicate, Result } from "effect"
import { z } from "zod"

import type { RelayConfig } from "./config.js"
import { recoverPromise } from "./effect/promise.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
import { appIdFromRouteOwner } from "./relay-resources.js"

/** Whether a name resolves: `unknown` when its nameservers didn't say. */
export type NameAnswer = "found" | "missing" | "unknown"

/** What Traefik's file configuration asks of its certificate resolver. */
export interface TraefikCertificateGate {
  /** Whether Traefik should ask for a certificate naming `hostname`. */
  readonly requests: (hostname: string) => boolean
  /** Raised to have Traefik ask again for every certificate it lacks. */
  readonly retry: number
  /** Which state this is, for `wrote`. */
  readonly version: number
}

/** A public database's name, which needs a certificate as a route does. */
export interface DatabaseCertificateName {
  readonly databaseId: string
  readonly hostname: string
}

/** A certificate Traefik holds, as PEM: its chain, leaf first, and key. */
export interface HeldCertificate {
  readonly chain: string
  readonly key: string
}

/** A hostname checked by hand, and the resource Hearth authorized. */
export interface ByHand {
  readonly hostname: string
  readonly owner: RelayPendingCertificate["owner"]
}

/** What looking up names found, for `apply`. */
export interface NameLookups {
  readonly answers: ReadonlyMap<string, NameAnswer>
  /** Whether `apply` has anything to do. */
  readonly due: boolean
}

export interface CertificateCheck {
  /** Traefik was set asking for the hostname checked by hand. */
  readonly asked: boolean
  /** What's pending changed, for the snapshot. */
  readonly changed: boolean
  /** Traefik's routes must be written again. */
  readonly rewrite: boolean
}

interface Pending {
  /** DNS checks that found it missing, for their backoff. */
  attempts: number
  failed: boolean
  nextCheckAt: number
  owner: RelayPendingCertificate["owner"]
  /** When Traefik last started asking for it. */
  since: number
  waitingFor: RelayPendingCertificate["waitingFor"]
}

const second = 1_000
const minute = 60 * second
const hour = 60 * minute
// DNS checks cost nothing at Let's Encrypt.
const dnsDelays = [15 * second, 30 * second, minute, 2 * minute, 5 * minute]
const dnsDelayCap = 10 * minute
// Issuance takes seconds; still missing after this, it most likely failed.
const issueTime = 2 * minute
// Let's Encrypt allows five failed validations per hostname an hour, and the
// first ask was one. Asks by hand reach every hostname, so this is per Relay.
const asksPerHour = 4
// How long a record just changed is given before its certificate is asked
// for, then how long each ask is given before the next.
const settleTime = 15 * second
const movedRetries = [45 * second, 2 * minute, 10 * minute]

// Traefik's acme.json; only the certificates' names matter.
const acmeStoreSchema = z.record(
  z.string(),
  z
    .object({
      Certificates: z
        .array(
          z.object({
            domain: z.object({
              main: z.string(),
              sans: z.array(z.string()).nullish(),
            }),
          })
        )
        .nullish(),
    })
    .nullable()
)

// The same, with each certificate's chain and key, base64 PEM as Traefik
// keeps them, read only for a public database's name.
const acmeCertificatesSchema = z.record(
  z.string(),
  z
    .object({
      Certificates: z
        .array(
          z.object({
            certificate: z.string(),
            domain: z.object({
              main: z.string(),
              sans: z.array(z.string()).nullish(),
            }),
            key: z.string(),
          })
        )
        .nullish(),
    })
    .nullable()
)

export class WebCertificates {
  readonly #pending = new Map<string, Pending>()
  readonly #resolve: (hostname: string) => Promise<NameAnswer>
  readonly #storePath: string
  // Names with a certificate; null (all count) until acme.json reads.
  #issued: ReadonlySet<string> | null = null
  // Names that resolve, but not here yet.
  readonly #held = new Set<string>()
  // Names whose records were just pointed here, and how often each has been
  // asked for again.
  readonly #moved = new Map<string, number>()
  // Asks by hand within the last hour.
  #asks: Array<number> = []
  #retry = 0
  #served: ReadonlyMap<string, Pending["owner"]> = new Map()
  #storeVersion: string | null = null
  // A rewrite stays owed until one is written, as when a paused Relay turns
  // it away.
  #version = 0
  #written = 0
  #wake: (() => void) | null = null

  constructor(options: {
    readonly resolve: (hostname: string) => Promise<NameAnswer>
    /** Traefik's acme.json. */
    readonly storePath: string
  }) {
    this.#resolve = options.resolve
    this.#storePath = options.storePath
  }

  /**
   * Follows the routes the bundled Traefik serves, and public databases'
   * names; none without it.
   */
  async track(
    routes: ReadonlyArray<RelayStoredWebRoute>,
    databases: ReadonlyArray<DatabaseCertificateName> = []
  ): Promise<void> {
    const served = new Map<string, Pending["owner"]>()
    for (const { databaseId, hostname } of databases) {
      served.set(hostname.toLowerCase(), { id: databaseId, kind: "database" })
    }
    for (const route of routes) {
      const appId = appIdFromRouteOwner(route.instanceId)
      const owner = appId
        ? { id: appId, kind: "app" as const }
        : { id: route.instanceId, kind: "server" as const }
      for (const hostname of webRouteHostnames(route)) {
        served.set(hostname.toLowerCase(), owner)
      }
    }
    this.#served = served
    for (const hostname of this.#pending.keys()) {
      if (!served.has(hostname)) this.#pending.delete(hostname)
    }
    for (const hostname of this.#held) {
      if (!served.has(hostname)) this.#held.delete(hostname)
    }
    for (const hostname of this.#moved.keys()) {
      if (!served.has(hostname)) this.#moved.delete(hostname)
    }
    if (served.size === 0) return
    await this.#readStore()
    let added = false
    const now = Date.now()
    for (const [hostname, owner] of served) {
      const pending = this.#pending.get(hostname)
      if (pending) {
        pending.owner = owner
      } else if (!this.#hasCertificate(hostname)) {
        this.#pending.set(hostname, {
          attempts: 0,
          failed: false,
          nextCheckAt: now,
          owner,
          since: 0,
          waitingFor: "dns",
        })
        added = true
      }
    }
    if (added) this.#wake?.()
  }

  /** Asks for no certificate naming these until they're released. */
  hold(hostnames: Iterable<string>): void {
    for (const hostname of hostnames) this.#held.add(hostname.toLowerCase())
  }

  /**
   * Asks for these soon, held or not, now that their records point here. One
   * asked for already, as by a Relay that restarted meanwhile, failed while
   * they pointed elsewhere.
   */
  release(hostnames: Iterable<string>): void {
    const now = Date.now()
    for (const hostname of hostnames) {
      const name = hostname.toLowerCase()
      this.#held.delete(name)
      const pending = this.#pending.get(name)
      if (!pending) continue
      this.#moved.set(name, 0)
      pending.failed = false
      if (pending.waitingFor === "dns") pending.nextCheckAt = now + settleTime
      else pending.since = now
    }
  }

  /** For writing Traefik's routes as things stand now. */
  gate(): TraefikCertificateGate {
    const unresolved = new Set(
      [...this.#pending]
        .filter(([, pending]) => pending.waitingFor === "dns")
        .map(([hostname]) => hostname)
    )
    return {
      requests: (hostname) => !unresolved.has(hostname.toLowerCase()),
      retry: this.#retry,
      version: this.#version,
    }
  }

  /** Notes that Traefik's routes were written as `gate` had them. */
  wrote(gate: TraefikCertificateGate): void {
    this.#written = Math.max(this.#written, gate.version)
  }

  /** The hostnames still waiting, for the Relay's snapshot. */
  pending(): Array<RelayPendingCertificate> {
    return [...this.#pending]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hostname, pending]) => ({
        failed: pending.failed,
        hostname,
        owner: pending.owner,
        waitingFor: pending.waitingFor,
      }))
  }

  /** `lookUp` then `apply`, for a check by hand under the routes lock. */
  async check(byHand?: ByHand): Promise<CertificateCheck> {
    if (byHand) this.#ownedHostname(byHand)
    return this.apply(await this.lookUp(byHand), byHand)
  }

  /**
   * Looks up the due names, or the one checked by hand. Changes nothing,
   * so it needs no lock.
   */
  async lookUp(byHand?: ByHand): Promise<NameLookups> {
    const hostname = byHand?.hostname.toLowerCase()
    const answers = new Map<string, NameAnswer>()
    const now = Date.now()
    for (const [name, pending] of this.#pending) {
      const wanted =
        hostname === undefined
          ? pending.waitingFor === "dns" &&
            pending.nextCheckAt <= now &&
            !this.#held.has(name)
          : name === hostname
      if (wanted) answers.set(name, await this.#resolve(name))
    }
    // Waiting hostnames may also have their certificate now, or be due to
    // show as failed; applying finds out.
    const due =
      answers.size > 0 ||
      this.#version !== this.#written ||
      [...this.#pending.values()].some(
        (pending) =>
          pending.waitingFor === "certificate" &&
          !pending.failed &&
          now - pending.since >= issueTime
      ) ||
      [...this.#pending].some(([name, pending]) =>
        this.#askAgain(name, pending, now)
      ) ||
      (this.#pending.size > 0 && (await this.#storeChanged()))
    return { answers, due }
  }

  /**
   * Applies what `lookUp` found, under the routes lock. Only a hostname
   * checked by hand, and served by its owner's routes, has Traefik ask again.
   */
  async apply(
    lookups: NameLookups,
    byHand?: ByHand
  ): Promise<CertificateCheck> {
    const hostname = byHand ? this.#ownedHostname(byHand) : undefined
    const result = { asked: false, changed: false }
    if (this.#pending.size > 0) {
      await this.#readStore()
      this.#applyLookups(result, lookups.answers, hostname)
    }
    return { ...result, rewrite: this.#version !== this.#written }
  }

  #ownedHostname(byHand: ByHand): string {
    const hostname = byHand.hostname.toLowerCase()
    const owner = this.#served.get(hostname)
    if (owner?.kind !== byHand.owner.kind || owner.id !== byHand.owner.id) {
      throw new Error(
        byHand.owner.kind === "database"
          ? `This database isn't public at ${hostname}`
          : `No route of this ${byHand.owner.kind === "app" ? "App" : "game server"} serves ${hostname}`
      )
    }
    return hostname
  }

  // Whether a moved name is due to be asked for again.
  #askAgain(name: string, pending: Pending, now: number): boolean {
    const retry = movedRetries[this.#moved.get(name) ?? movedRetries.length]
    return (
      retry !== undefined &&
      pending.waitingFor === "certificate" &&
      now - pending.since >= retry
    )
  }

  // Whether the Relay may ask Let's Encrypt again for what it lacks.
  #mayAsk(now: number): boolean {
    this.#asks = this.#asks.filter((ask) => ask > now - hour)
    return this.#asks.length < asksPerHour
  }

  // Has Traefik ask again, for every certificate it lacks, so each starts
  // over.
  #ask(now: number): void {
    this.#asks.push(now)
    for (const other of this.#pending.values()) {
      if (other.waitingFor !== "certificate") continue
      other.failed = false
      other.since = now
    }
    this.#retry += 1
    this.#version += 1
  }

  #applyLookups(
    result: { asked: boolean; changed: boolean },
    answers: ReadonlyMap<string, NameAnswer>,
    hostname: string | undefined
  ): void {
    const now = Date.now()
    const again = [...this.#pending].filter(
      ([name, pending]) =>
        !this.#hasCertificate(name) && this.#askAgain(name, pending, now)
    )
    if (again.length > 0 && this.#mayAsk(now)) {
      for (const [name] of again) {
        this.#moved.set(name, (this.#moved.get(name) ?? 0) + 1)
      }
      this.#ask(now)
      result.changed = true
    }
    for (const [name, pending] of this.#pending) {
      if (this.#hasCertificate(name)) {
        this.#pending.delete(name)
        this.#moved.delete(name)
        result.changed = true
        if (pending.waitingFor === "dns") this.#version += 1
        continue
      }
      if (
        pending.waitingFor === "certificate" &&
        !pending.failed &&
        now - pending.since >= issueTime
      ) {
        pending.failed = true
        result.changed = true
      }
      const answer = answers.get(name)
      if (answer === undefined) continue
      if (answer === "missing") {
        if (pending.waitingFor === "certificate") {
          pending.waitingFor = "dns"
          pending.attempts = 0
          this.#version += 1
        }
        pending.attempts += 1
        pending.failed = true
        pending.nextCheckAt =
          now + (dnsDelays[pending.attempts - 1] ?? dnsDelayCap)
        result.changed = true
        continue
      }
      if (pending.waitingFor === "dns") {
        pending.waitingFor = "certificate"
        pending.failed = false
        pending.since = now
        result.changed = true
        if (name === hostname) result.asked = true
        this.#version += 1
        continue
      }
      // Asked again by hand.
      if (name !== hostname) continue
      if (!this.#mayAsk(now)) continue
      this.#ask(now)
      result.asked = true
      result.changed = true
    }
  }

  /** Resolves once a hostname newly waits. */
  woken(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = () => {
        this.#wake = null
        resolve()
      }
    })
  }

  /**
   * The certificate Traefik holds for `hostname` itself, read afresh, or
   * null. A database is given its own name's, never a wildcard's.
   */
  async certificate(hostname: string): Promise<HeldCertificate | null> {
    const text = await recoverPromise(
      () => readFile(this.#storePath, "utf8"),
      () => null
    )
    if (!text?.trim()) return null
    const parsed = acmeCertificatesSchema.safeParse(
      Result.getOrNull(Result.try(() => JSON.parse(text) as unknown))
    )
    if (!parsed.success) return null
    const name = hostname.toLowerCase()
    for (const resolver of Object.values(parsed.data)) {
      for (const held of resolver?.Certificates ?? []) {
        const names = [held.domain.main, ...(held.domain.sans ?? [])]
        if (!names.some((candidate) => candidate.toLowerCase() === name)) {
          continue
        }
        const chain = Buffer.from(held.certificate, "base64").toString("utf8")
        const key = Buffer.from(held.key, "base64").toString("utf8")
        if (
          chain.includes("BEGIN CERTIFICATE") &&
          key.includes("PRIVATE KEY")
        ) {
          return { chain, key }
        }
      }
    }
    return null
  }

  #hasCertificate(hostname: string): boolean {
    if (this.#issued === null || isIP(hostname) !== 0) return true
    if (this.#issued.has(hostname)) return true
    const dot = hostname.indexOf(".")
    return dot > 0 && this.#issued.has(`*${hostname.slice(dot)}`)
  }

  async #storeChanged(): Promise<boolean> {
    const before = this.#storeVersion
    await this.#readStore()
    return this.#storeVersion !== before
  }

  // Rereads acme.json when it changes, keeping what it had while Traefik is
  // partway through writing it.
  async #readStore(): Promise<void> {
    const version = await recoverPromise(
      async () => {
        const stats = await stat(this.#storePath)
        return `${stats.mtimeMs}:${stats.size}`
      },
      (cause) => (hasCode(cause, "ENOENT") ? "missing" : null)
    )
    if (version === null || version === this.#storeVersion) return
    const text =
      version === "missing"
        ? ""
        : await recoverPromise(
            () => readFile(this.#storePath, "utf8"),
            () => null
          )
    if (text === null) return
    // Missing or empty before Traefik first writes it: no certificates.
    if (text.trim() === "") {
      this.#issued = new Set()
      this.#storeVersion = version
      return
    }
    const parsed = acmeStoreSchema.safeParse(
      Result.getOrNull(Result.try(() => JSON.parse(text) as unknown))
    )
    if (!parsed.success) return
    const issued = new Set<string>()
    for (const resolver of Object.values(parsed.data)) {
      for (const certificate of resolver?.Certificates ?? []) {
        issued.add(certificate.domain.main.toLowerCase())
        for (const san of certificate.domain.sans ?? []) {
          issued.add(san.toLowerCase())
        }
      }
    }
    this.#issued = issued
    this.#storeVersion = version
  }
}

/** Where the bundled Traefik keeps its certificates. */
export function webCertificateStorePath(
  config: Pick<RelayConfig, "dataDirectory">
): string {
  return join(
    config.dataDirectory,
    "infrastructure",
    "traefik",
    "state",
    "acme.json"
  )
}

/** The DNS queries a name check makes. */
export interface DnsQueries {
  /** NS records, from the Relay's resolver. */
  readonly nameservers: (name: string) => Promise<ReadonlyArray<string>>
  /** A nameserver's addresses, from the Relay's resolver. */
  readonly addresses: (host: string) => Promise<ReadonlyArray<string>>
  /** Records asked of `servers` directly. */
  readonly records: (
    servers: ReadonlyArray<string>,
    name: string,
    type: "A" | "AAAA" | "CNAME"
  ) => Promise<ReadonlyArray<unknown>>
}

const lookupTimeout = { timeout: 2_000, tries: 2 }
const relayResolver = new dns.Resolver(lookupTimeout)

/** Over the network, each giving up within a few seconds. */
export const networkDnsQueries: DnsQueries = {
  addresses: (host) => relayResolver.resolve4(host),
  nameservers: (name) => relayResolver.resolveNs(name),
  records: (servers, name, type) => {
    const resolver = new dns.Resolver(lookupTimeout)
    resolver.setServers([...servers])
    return type === "A"
      ? resolver.resolve4(name)
      : type === "AAAA"
        ? resolver.resolve6(name)
        : resolver.resolveCname(name)
  },
}

/**
 * Whether a hostname resolves, asked of its zone's own nameservers: a
 * resolver asked too early would remember it as missing. `unknown` when
 * they can't be reached.
 */
export function nameResolver(
  queries: DnsQueries
): (hostname: string) => Promise<NameAnswer> {
  // Its own nameservers' addresses; null when they can't be found.
  const serversOf = async (
    name: string
  ): Promise<ReadonlyArray<string> | null> => {
    const names = await recoverPromise(
      () => queries.nameservers(name),
      (cause): ReadonlyArray<string> | null =>
        hasCode(cause, dns.NODATA) || hasCode(cause, dns.NOTFOUND) ? [] : null
    )
    if (names === null || names.length === 0) return names
    const addresses = await Promise.all(
      names.map((host) =>
        recoverPromise(
          () => queries.addresses(host),
          (): ReadonlyArray<string> => []
        )
      )
    )
    const unique = [...new Set(addresses.flat())]
    return unique.length > 0 ? unique : null
  }
  // `nodata`: it exists without an address, or `servers` only refer to its
  // own nameservers.
  const addressAnswer = async (
    servers: ReadonlyArray<string>,
    name: string
  ): Promise<NameAnswer | "nodata"> => {
    for (const type of ["A", "AAAA", "CNAME"] as const) {
      const answer = await recoverPromise(
        async (): Promise<NameAnswer | null> =>
          (await queries.records(servers, name, type)).length > 0
            ? "found"
            : null,
        (cause): NameAnswer | null =>
          hasCode(cause, dns.NOTFOUND)
            ? "missing"
            : hasCode(cause, dns.NODATA)
              ? null
              : "unknown"
      )
      if (answer) return answer
    }
    return "nodata"
  }
  return async (hostname) => {
    // Its zone, searched from its parent so the name never reaches a
    // resolver before it exists.
    const labels = hostname.split(".")
    let servers: ReadonlyArray<string> | null = []
    for (
      let index = labels.length > 2 ? 1 : 0;
      index < labels.length - 1 && servers?.length === 0;
      index++
    ) {
      servers = await serversOf(labels.slice(index).join("."))
    }
    if (!servers || servers.length === 0) return "unknown"
    const answer = await addressAnswer(servers, hostname)
    if (answer !== "nodata") return answer
    // It exists, so asking a resolver for its own nameservers is safe. With
    // none it has no address yet; with some, it's its own zone (as under a
    // two-label suffix) and they answer.
    const own = await serversOf(hostname)
    if (own === null) return "unknown"
    if (own.length === 0) return "missing"
    const delegated = await addressAnswer(own, hostname)
    return delegated === "nodata" ? "missing" : delegated
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return Predicate.hasProperty(cause, "code") && cause.code === code
}
