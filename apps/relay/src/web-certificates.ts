/**
 * Certificates for the web routes the bundled Traefik serves.
 *
 * Traefik asks Let's Encrypt for a hostname's certificate when a route
 * naming it first appears, and again only when its configuration next
 * changes. Asked before the name resolves, Let's Encrypt answers NXDOMAIN,
 * its resolvers may remember that answer, and Traefik never asks again on
 * its own, so the route serves Traefik's default certificate until some
 * other route changes.
 *
 * So Traefik asks for a hostname only once its name resolves at its
 * domain's own nameservers, which have a new record first and remember no
 * answer, unlike a resolver. Until then the Relay checks the name now and
 * then, which costs nothing at Let's Encrypt. Once Traefik has asked, the
 * Relay doesn't ask again on its own: someone checking a hostname by hand
 * has Traefik ask again. That changes Traefik's configuration, which has it
 * ask again for every certificate it lacks, so the Relay as a whole does so
 * a few times an hour at most. Other changes to its routes, and restarts,
 * have Traefik ask again too; this only keeps Kiln's own asks down.
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

/** Someone asking about a hostname, and the resource Hearth let them ask for. */
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

/** What checking hostnames found, for whoever writes Traefik's routes. */
export interface CertificateCheck {
  /** Whether Traefik was set asking for the hostname checked by hand. */
  readonly asked: boolean
  /** Whether what's pending changed, for the Relay's snapshot. */
  readonly changed: boolean
  /** Whether Traefik's routes must be written again. */
  readonly rewrite: boolean
}

interface Pending {
  /** Checks of its name that found it missing. */
  attempts: number
  /** Traefik asked a while ago and has no certificate yet. */
  failed: boolean
  /** When its name is next checked, while it doesn't resolve. */
  nextCheckAt: number
  owner: RelayPendingCertificate["owner"]
  /** When Traefik last started asking for it. */
  since: number
  waitingFor: RelayPendingCertificate["waitingFor"]
}

const second = 1_000
const minute = 60 * second
const hour = 60 * minute
// Asking a name's nameservers costs nothing, so these start soon after its
// record is likely made.
const dnsDelays = [15 * second, 30 * second, minute, 2 * minute, 5 * minute]
const dnsDelayCap = 10 * minute
// Issuance takes seconds; one still missing after this has most likely failed.
const issueTime = 2 * minute
// Let's Encrypt allows five failed validations per hostname an hour; Traefik
// asking when the route appeared was one. Each ask by hand reaches every
// hostname without a certificate, so the limit is the Relay's.
const asksPerHour = 4

// Traefik's acme.json: each resolver's certificates. Only their names matter.
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

export class WebCertificates {
  readonly #pending = new Map<string, Pending>()
  readonly #resolve: (hostname: string) => Promise<NameAnswer>
  readonly #storePath: string
  // Names Traefik holds a certificate for; null until its store first reads,
  // and while it can't be read, every hostname counts as having one.
  #issued: ReadonlySet<string> | null = null
  // When Traefik was set asking again by hand, within the last hour.
  #asks: Array<number> = []
  #retry = 0
  // Who serves each hostname the bundled Traefik serves.
  #served: ReadonlyMap<string, Pending["owner"]> = new Map()
  #storeVersion: string | null = null
  // Raised when Traefik's routes need writing again; `#written` is the one
  // last written, so a write that didn't happen, as while the Relay is
  // paused, is still owed.
  #version = 0
  #written = 0
  #wake: (() => void) | null = null

  constructor(options: {
    /** Asks a name's own nameservers whether it resolves. */
    readonly resolve: (hostname: string) => Promise<NameAnswer>
    /** Traefik's acme.json. */
    readonly storePath: string
  }) {
    this.#resolve = options.resolve
    this.#storePath = options.storePath
  }

  /**
   * Follows the hostnames the bundled Traefik serves: `routes`, or none
   * when no bundled Traefik serves them. One without a certificate waits
   * until its name resolves; the next check looks at once.
   */
  async track(routes: ReadonlyArray<RelayStoredWebRoute>): Promise<void> {
    const served = new Map<string, Pending["owner"]>()
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

  /** For writing Traefik's configuration as things stand now. */
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

  /**
   * Checks the names of hostnames waiting for DNS that are due, or only
   * one now, as when someone who may change its route asks: `lookUp`,
   * then `apply`. The caller holds the routes lock.
   */
  async check(byHand?: ByHand): Promise<CertificateCheck> {
    if (byHand) this.#ownedHostname(byHand)
    return this.apply(await this.lookUp(byHand), byHand)
  }

  /**
   * Looks up the names of hostnames waiting for DNS that are due, or the
   * one asked about. Changes nothing, so it needs no lock; `due` says
   * whether `apply` has anything to do.
   */
  async lookUp(byHand?: ByHand): Promise<NameLookups> {
    const hostname = byHand?.hostname.toLowerCase()
    const answers = new Map<string, NameAnswer>()
    if (this.#pending.size === 0) {
      return { answers, due: this.#version !== this.#written }
    }
    await this.#readStore()
    const now = Date.now()
    let due = this.#version !== this.#written
    // Routes can change while names are looked up; iterating the Map as it
    // changes is safe.
    for (const [name, pending] of this.#pending) {
      if (this.#hasCertificate(name)) {
        due = true
        continue
      }
      if (
        pending.waitingFor === "certificate" &&
        !pending.failed &&
        now - pending.since >= issueTime
      ) {
        due = true
      }
      const wanted =
        hostname === undefined
          ? pending.waitingFor === "dns" && pending.nextCheckAt <= now
          : name === hostname
      if (wanted) answers.set(name, await this.#resolve(name))
    }
    return { answers, due: due || answers.size > 0 }
  }

  /**
   * Applies what `lookUp` found, with the routes lock held, so checks and
   * route writes change things in turn. Only one asked about by hand has
   * Traefik ask again, and it's refused unless `owner`'s routes serve it.
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
        `No route of this ${byHand.owner.kind === "app" ? "App" : "game server"} serves ${hostname}`
      )
    }
    return hostname
  }

  #applyLookups(
    result: { asked: boolean; changed: boolean },
    answers: ReadonlyMap<string, NameAnswer>,
    hostname: string | undefined
  ): void {
    const now = Date.now()
    // Deleting from a Map while iterating it is safe.
    for (const [name, pending] of this.#pending) {
      if (this.#hasCertificate(name)) {
        this.#pending.delete(name)
        result.changed = true
        // Traefik holds one it wasn't asking for, such as from before.
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
          // Traefik stops asking until it resolves again.
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
        // Asking for it at all changes Traefik's configuration.
        pending.waitingFor = "certificate"
        pending.failed = false
        pending.since = now
        result.changed = true
        if (name === hostname) result.asked = true
        this.#version += 1
        continue
      }
      // It resolves and Traefik has asked: only someone asking by hand has
      // it ask again.
      if (name !== hostname) continue
      // Traefik asks again for every certificate it lacks, so each of them
      // starts over.
      this.#asks = this.#asks.filter((ask) => ask > now - hour)
      if (this.#asks.length >= asksPerHour) continue
      this.#asks.push(now)
      for (const other of this.#pending.values()) {
        if (other.waitingFor !== "certificate") continue
        other.failed = false
        other.since = now
      }
      this.#retry += 1
      result.asked = true
      result.changed = true
      this.#version += 1
    }
  }

  /** Resolves once a hostname newly waits, for the loop that checks them. */
  woken(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = () => {
        this.#wake = null
        resolve()
      }
    })
  }

  #hasCertificate(hostname: string): boolean {
    if (this.#issued === null || isIP(hostname) !== 0) return true
    if (this.#issued.has(hostname)) return true
    const dot = hostname.indexOf(".")
    return dot > 0 && this.#issued.has(`*${hostname.slice(dot)}`)
  }

  // Reads Traefik's store when it has changed. One that can't be read keeps
  // what was read before, as Traefik may be partway through writing it.
  async #readStore(): Promise<void> {
    const version = await recoverPromise(
      async () => {
        const stats = await stat(this.#storePath)
        return `${stats.mtimeMs}:${stats.size}`
      },
      (cause) => (hasCode(cause, "ENOENT") ? "missing" : null)
    )
    if (version === null || version === this.#storeVersion) return
    if (version === "missing") {
      this.#issued = new Set()
      this.#storeVersion = version
      return
    }
    const text = await recoverPromise(
      () => readFile(this.#storePath, "utf8"),
      () => null
    )
    if (text === null) return
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
  /** A name's own NS records, asked of the Relay's resolver. */
  readonly nameservers: (name: string) => Promise<ReadonlyArray<string>>
  /** A nameserver's addresses, asked of the Relay's resolver. */
  readonly addresses: (host: string) => Promise<ReadonlyArray<string>>
  /** A name's records of one type, asked of `servers` directly. */
  readonly records: (
    servers: ReadonlyArray<string>,
    name: string,
    type: "A" | "AAAA" | "CNAME"
  ) => Promise<ReadonlyArray<unknown>>
}

const lookupTimeout = { timeout: 2_000, tries: 2 }
const relayResolver = new dns.Resolver(lookupTimeout)

/** The queries over the network, each giving up within a few seconds. */
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
 * Checks whether a hostname resolves, asked of its zone's own nameservers
 * rather than a resolver: they have a new record first, and a resolver
 * asked too early would remember the name as missing, for whoever uses it
 * next. `unknown` when they can't be reached or don't say.
 */
export function nameResolver(
  queries: DnsQueries
): (hostname: string) => Promise<NameAnswer> {
  // The addresses of a name's own nameservers: none when it has none, null
  // when they can't be found.
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
  // What `servers` say of a name's addresses: `nodata` when it exists
  // without one, or they only refer to nameservers of its own.
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
    // The zone holding it, searched from its parent so the name itself
    // never reaches a resolver before it exists; a domain's own name starts
    // with itself.
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
    // It exists, so asking for its own nameservers remembers nothing
    // missing. With none, it has no address yet; with some, it's a zone of
    // its own, as a domain under a two-label suffix is, and they answer.
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
