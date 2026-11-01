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
 * has Traefik ask again, a few times an hour at most.
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
}

/** What checking hostnames found, for whoever writes Traefik's routes. */
export interface CertificateCheck {
  /** Whether Traefik was set asking again for the hostname checked by hand. */
  readonly asked: boolean
  /** Whether what's pending changed, for the Relay's snapshot. */
  readonly changed: boolean
  /** Whether Traefik's routes must be written again. */
  readonly rewrite: boolean
}

interface Pending {
  /** Checks of its name that found it missing. */
  attempts: number
  /** When it was last asked for by hand, within the last hour. */
  asks: Array<number>
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
// asking when the route appeared was one.
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
  #retry = 0
  #storeVersion: string | null = null
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
          asks: [],
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
    }
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
   * `hostname` now, as when someone asks. One checked by hand that already
   * resolves has Traefik ask again.
   */
  async check(hostname?: string): Promise<CertificateCheck> {
    const result = { asked: false, changed: false, rewrite: false }
    if (this.#pending.size === 0) return result
    await this.#readStore()
    // Deleting from a Map while iterating it is safe.
    for (const [name, pending] of this.#pending) {
      if (this.#hasCertificate(name)) {
        this.#pending.delete(name)
        result.changed = true
        // Traefik holds one it wasn't asking for, such as from before.
        if (pending.waitingFor === "dns") result.rewrite = true
        continue
      }
      const now = Date.now()
      const byHand = name === hostname
      if (pending.waitingFor === "certificate") {
        if (!pending.failed && now - pending.since >= issueTime) {
          pending.failed = true
          result.changed = true
        }
        if (!byHand) continue
      } else if (hostname === undefined ? pending.nextCheckAt > now : !byHand) {
        continue
      }
      const answer = await this.#resolve(name)
      // Its route went while its name was looked up.
      if (this.#pending.get(name) !== pending) continue
      const resolvedAt = Date.now()
      if (answer === "missing") {
        if (pending.waitingFor === "certificate") {
          // Traefik stops asking until it resolves again.
          pending.waitingFor = "dns"
          pending.failed = false
          pending.attempts = 0
          result.changed = true
          result.rewrite = true
        }
        pending.attempts += 1
        pending.failed = true
        pending.nextCheckAt =
          resolvedAt + (dnsDelays[pending.attempts - 1] ?? dnsDelayCap)
        result.changed = true
        continue
      }
      if (pending.waitingFor === "dns") {
        // Asking for it at all changes Traefik's configuration.
        pending.waitingFor = "certificate"
        pending.failed = false
        pending.since = resolvedAt
        result.changed = true
        result.rewrite = true
        continue
      }
      // Asked again by hand, within Let's Encrypt's limit.
      pending.asks = pending.asks.filter((ask) => ask > resolvedAt - hour)
      if (pending.asks.length >= asksPerHour) continue
      pending.asks.push(resolvedAt)
      pending.failed = false
      pending.since = resolvedAt
      this.#retry += 1
      result.asked = true
      result.changed = true
      result.rewrite = true
    }
    return result
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

/**
 * Whether `hostname` resolves, asked of its zone's own nameservers rather
 * than a resolver: they have a new record first, and a resolver asked too
 * early would remember the name as missing, for whoever uses it next.
 * `unknown` when they can't be reached or don't give an answer.
 */
export async function authoritativeNameAnswer(
  hostname: string
): Promise<NameAnswer> {
  const servers = await zoneNameservers(hostname)
  if (servers.length === 0) return "unknown"
  const resolver = new dns.Resolver({ timeout: 2_000, tries: 2 })
  resolver.setServers(servers)
  for (const lookup of [
    () => resolver.resolve4(hostname),
    () => resolver.resolve6(hostname),
    () => resolver.resolveCname(hostname),
  ]) {
    const answer = await recoverPromise(
      async (): Promise<NameAnswer | null> =>
        (await lookup()).length > 0 ? "found" : null,
      (cause): NameAnswer | null =>
        hasCode(cause, dns.NOTFOUND)
          ? "missing"
          : hasCode(cause, dns.NODATA)
            ? null
            : "unknown"
    )
    if (answer) return answer
  }
  // It exists without an address, or is delegated elsewhere.
  return "unknown"
}

// The addresses of the nameservers of the zone holding `hostname`. The
// search starts at its parent, so the name itself never reaches a resolver
// before it exists; a domain's own name starts with itself.
async function zoneNameservers(hostname: string): Promise<Array<string>> {
  const labels = hostname.split(".")
  for (
    let index = labels.length > 2 ? 1 : 0;
    index < labels.length - 1;
    index++
  ) {
    const names = await recoverPromise(
      () => dns.resolveNs(labels.slice(index).join(".")),
      // A name with no nameservers of its own is in its parent's zone.
      (cause) =>
        hasCode(cause, dns.NODATA) || hasCode(cause, dns.NOTFOUND) ? [] : null
    )
    if (names === null) return []
    if (names.length === 0) continue
    const addresses = await Promise.all(
      names.map((name) =>
        recoverPromise(
          () => dns.resolve4(name),
          (): Array<string> => []
        )
      )
    )
    return [...new Set(addresses.flat())]
  }
  return []
}

function delay(
  delays: ReadonlyArray<number>,
  cap: number,
  index: number
): number {
  return delays[index] ?? cap
}

function hasCode(cause: unknown, code: string): boolean {
  return Predicate.hasProperty(cause, "code") && cause.code === code
}
