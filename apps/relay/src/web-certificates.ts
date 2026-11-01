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
 * So the Relay decides when Traefik asks. A hostname without a certificate
 * has Traefik ask only once its name resolves at its domain's own
 * nameservers, which have a new record first and remember no answer, unlike
 * a resolver. Traefik then asks for a short window; if no certificate comes,
 * it stops asking until the hostname's next retry, so other changes to its
 * configuration never ask for it in between. Retries spread from minutes to
 * hourly, then daily once it has failed for a day, and every ask stays
 * within Let's Encrypt's limits: five failed validations per hostname an
 * hour, and 300 orders per account in three hours. What each hostname waits
 * for is kept in the Relay's state, so a restart doesn't start it over.
 */
import { promises as dns } from "node:dns"
import { readFile, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { join } from "node:path"

import {
  webRouteHostnames,
  type RelayPendingCertificate,
} from "@workspace/contracts"
import { Effect, Predicate, Result } from "effect"
import { z } from "zod"

import type { RelayConfig } from "./config.js"
import { recoverPromise } from "./effect/promise.js"
import type { RelayStateStore, RelayStoredWebRoute } from "./effect/state.js"
import { appIdFromRouteOwner } from "./relay-resources.js"

/** Whether a name resolves: `unknown` when its nameservers didn't say. */
export type NameAnswer = "found" | "missing" | "unknown"

/** What Traefik's file configuration asks of its certificate resolver. */
export interface TraefikCertificateGate {
  /** Whether Traefik should ask for a certificate naming `hostname`. */
  readonly requests: (hostname: string) => boolean
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
  /** Checks or requests that failed since it last changed what it waits for. */
  attempts: number
  nextCheckAt: number
  /** Whether Traefik is asking for its certificate now. */
  open: boolean
  /** When Traefik was set asking for it, within the last hour. */
  opens: Array<number>
  /** The game server or App whose route serves it; null until one does. */
  owner: RelayPendingCertificate["owner"] | null
  /** When it first resolved and Traefik first asked; 0 while it doesn't. */
  since: number
  waitingFor: RelayPendingCertificate["waitingFor"]
}

const second = 1_000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour
// Asking a name's nameservers costs nothing, so these start soon after its
// record is likely made.
const dnsDelays = [15 * second, 30 * second, minute, 2 * minute, 5 * minute]
const dnsDelayCap = 10 * minute
// How long Traefik asks once set asking; issuance takes seconds.
const askWindow = 90 * second
// Between asks: at most four an hour, then hourly, then daily once a
// hostname has failed for a day.
const certificateDelays = [2 * minute, 10 * minute, 30 * minute]
// Let's Encrypt allows five failed validations per hostname an hour. One is
// left for Traefik asking again within a window, as when a route saves.
const asksPerHostnameHour = 4
// Let's Encrypt allows 300 orders per account in three hours. Some are left
// for renewals and the Relay's own address.
const asksPerRelayHour = 60

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
  readonly #state: RelayStateStore["Service"]
  readonly #storePath: string
  // When Traefik was set asking for any hostname, within the last hour.
  #asks: Array<number> = []
  // Names Traefik holds a certificate for; null until its store first reads,
  // and while it can't be read, every hostname counts as having one.
  #issued: ReadonlySet<string> | null = null
  #loaded: Promise<void> | null = null
  #storeVersion: string | null = null
  #wake: (() => void) | null = null

  constructor(options: {
    /** Asks a name's own nameservers whether it resolves. */
    readonly resolve: (hostname: string) => Promise<NameAnswer>
    /** Where what each hostname waits for is kept. */
    readonly state: RelayStateStore["Service"]
    /** Traefik's acme.json. */
    readonly storePath: string
  }) {
    this.#resolve = options.resolve
    this.#state = options.state
    this.#storePath = options.storePath
  }

  /**
   * Follows the hostnames the bundled Traefik serves: `routes`, or none
   * when no bundled Traefik serves them. One without a certificate waits
   * until its name resolves; the next check looks at once.
   */
  async track(routes: ReadonlyArray<RelayStoredWebRoute>): Promise<void> {
    await this.#load()
    const served = new Map<string, NonNullable<Pending["owner"]>>()
    for (const route of routes) {
      const appId = appIdFromRouteOwner(route.instanceId)
      const owner = appId
        ? { id: appId, kind: "app" as const }
        : { id: route.instanceId, kind: "server" as const }
      for (const hostname of webRouteHostnames(route)) {
        served.set(hostname.toLowerCase(), owner)
      }
    }
    const gone = [...this.#pending.keys()].filter(
      (hostname) => !served.has(hostname)
    )
    for (const hostname of gone) this.#pending.delete(hostname)
    await this.#forget(gone)
    if (served.size === 0) return
    await this.#readStore()
    let added = false
    for (const [hostname, owner] of served) {
      const pending = this.#pending.get(hostname)
      if (pending) {
        pending.owner = owner
      } else if (!this.#hasCertificate(hostname)) {
        const fresh: Pending = {
          attempts: 0,
          nextCheckAt: Date.now(),
          open: false,
          opens: [],
          owner,
          since: 0,
          waitingFor: "dns",
        }
        this.#pending.set(hostname, fresh)
        await this.#save(hostname, fresh)
        added = true
      }
    }
    if (added) this.#wake?.()
  }

  /**
   * For writing Traefik's configuration as things stand now: it asks for a
   * hostname that has a certificate, so it renews it, and for one waiting
   * only while it's set asking.
   */
  gate(): TraefikCertificateGate {
    const closed = new Set(
      [...this.#pending]
        .filter(([, pending]) => !pending.open)
        .map(([hostname]) => hostname)
    )
    return { requests: (hostname) => !closed.has(hostname.toLowerCase()) }
  }

  /** The hostnames still waiting, for the Relay's snapshot. */
  pending(): Array<RelayPendingCertificate> {
    return [...this.#pending]
      .flatMap(([hostname, pending]) =>
        pending.owner
          ? [
              {
                failed: pending.attempts > 0,
                hostname,
                owner: pending.owner,
                waitingFor: pending.waitingFor,
              },
            ]
          : []
      )
      .sort((left, right) => left.hostname.localeCompare(right.hostname))
  }

  /**
   * Checks the hostnames that are due, or only `hostname` now, as when
   * someone asks. One checked by hand skips its wait, not its limits.
   */
  async check(hostname?: string): Promise<CertificateCheck> {
    await this.#load()
    const result = { asked: false, changed: false, rewrite: false }
    if (this.#pending.size === 0) return result
    await this.#readStore()
    // Deleting from a Map while iterating it is safe.
    for (const [name, pending] of this.#pending) {
      if (this.#hasCertificate(name)) {
        this.#pending.delete(name)
        await this.#forget([name])
        result.changed = true
        // Traefik asks for one it holds, so it renews it.
        if (!pending.open) result.rewrite = true
        continue
      }
      const now = Date.now()
      if (
        hostname === undefined ? pending.nextCheckAt > now : name !== hostname
      ) {
        continue
      }
      if (pending.open) {
        // Asked by hand while Traefik is asking: it's already trying.
        if (hostname !== undefined) continue
        // Its window passed without a certificate: stop asking until its
        // next retry.
        pending.open = false
        pending.attempts += 1
        pending.nextCheckAt = now + this.#retryDelay(pending, now)
        await this.#save(name, pending)
        result.changed = true
        result.rewrite = true
        continue
      }
      const answer = await this.#resolve(name)
      // Its route went while its name was looked up.
      if (this.#pending.get(name) !== pending) continue
      result.changed = true
      const resolvedAt = Date.now()
      if (answer === "missing") {
        if (pending.waitingFor === "certificate") {
          pending.waitingFor = "dns"
          pending.attempts = 0
          pending.since = 0
        }
        pending.attempts += 1
        pending.nextCheckAt =
          resolvedAt + delay(dnsDelays, dnsDelayCap, pending.attempts - 1)
        await this.#save(name, pending)
        continue
      }
      if (pending.waitingFor === "dns") {
        pending.waitingFor = "certificate"
        pending.attempts = 0
        pending.since = resolvedAt
      }
      const free = this.#askableAt(pending, resolvedAt)
      if (free > resolvedAt) {
        // Its limits are spent: it resolves, and waits its turn.
        pending.nextCheckAt = free
        await this.#save(name, pending)
        continue
      }
      pending.open = true
      pending.opens = [...recent(pending.opens, resolvedAt), resolvedAt]
      pending.nextCheckAt = resolvedAt + askWindow
      this.#asks = [...recent(this.#asks, resolvedAt), resolvedAt]
      await this.#save(name, pending)
      result.rewrite = true
      if (name === hostname) result.asked = true
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

  // When Traefik may next ask for a hostname within Let's Encrypt's limits:
  // its own, and the Relay's as a whole.
  #askableAt(pending: Pending, now: number): number {
    const own = recent(pending.opens, now)
    const relay = recent(this.#asks, now)
    return Math.max(
      now,
      own.length >= asksPerHostnameHour ? own[0]! + hour : now,
      relay.length >= asksPerRelayHour ? relay[0]! + hour : now
    )
  }

  #retryDelay(pending: Pending, now: number): number {
    if (now - pending.since >= day) return day
    return certificateDelays[pending.attempts - 1] ?? hour
  }

  // What each hostname waited for before a restart. Kept best effort: one
  // the Relay can't read or write starts over, rather than fail a route.
  #load(): Promise<void> {
    this.#loaded ??= this.#run(this.#state.listWebCertificates(), []).then(
      (records) => {
        for (const { hostname, ...record } of records) {
          if (this.#pending.has(hostname)) continue
          this.#pending.set(hostname, {
            ...record,
            opens: [...record.opens],
            owner: null,
          })
        }
      }
    )
    return this.#loaded
  }

  #save(hostname: string, pending: Pending): Promise<void> {
    const { owner: _owner, ...record } = pending
    return this.#run(
      this.#state.saveWebCertificate({ ...record, hostname }, Date.now()),
      undefined
    )
  }

  #forget(hostnames: ReadonlyArray<string>): Promise<void> {
    return this.#run(this.#state.deleteWebCertificates(hostnames), undefined)
  }

  #run<A, E>(effect: Effect.Effect<A, E>, fallback: A): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Keeping web route certificates failed",
            cause
          ).pipe(Effect.as(fallback))
        )
      )
    )
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

// The times within the hour before `now`, oldest first.
function recent(times: ReadonlyArray<number>, now: number): Array<number> {
  return times.filter((time) => time > now - hour)
}
