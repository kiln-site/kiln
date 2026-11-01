import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { RelayProxySettings } from "@workspace/contracts"
import { ManagedRuntime } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { parse } from "yaml"

import type { RelayConfig } from "./config.js"
import {
  makeRelayStateLayer,
  RelayStateStore,
  type RelayStoredWebRoute,
} from "./effect/state.js"
import { testRelayConfig } from "./test/fixtures.js"
import { traefikDynamicConfiguration } from "./traefik.js"
import {
  WebCertificates,
  webCertificateStorePath,
  type NameAnswer,
} from "./web-certificates.js"

const settings: RelayProxySettings = {
  acmeEmail: null,
  mode: "traefik",
  traefikImage: "traefik:v3.7.13",
}

const route: RelayStoredWebRoute = {
  hostname: "shop.example.com",
  httpsRedirect: true,
  id: "b00d4423",
  instanceId: "a".repeat(40),
  name: "Shop",
  path: null,
  primary: true,
  redirect: null,
  stripPrefix: false,
  targetPort: 8080,
  www: "none",
}

const routerName = "kiln-route-b00d4423"
const second = 1_000
const minute = 60 * second
const hour = 60 * minute

describe("bundled Traefik certificates", () => {
  let directory: string
  let config: RelayConfig
  let answers: Map<string, NameAnswer>
  let runtime: ManagedRuntime.ManagedRuntime<RelayStateStore, unknown>
  let certificates: WebCertificates

  beforeEach(async () => {
    // Only the clock: the state store's own scheduling keeps running.
    vi.useFakeTimers({ toFake: ["Date"] })
    directory = await mkdtemp(join(tmpdir(), "kiln-certificates-"))
    config = testRelayConfig(directory, { KILN_RELAY_PROXY: "traefik" })
    // Traefik's store, as the Relay creates it before Traefik first starts.
    await mkdir(dirname(webCertificateStorePath(config)), { recursive: true })
    await writeFile(webCertificateStorePath(config), "")
    answers = new Map()
    runtime = ManagedRuntime.make(
      makeRelayStateLayer(join(directory, "relay.sqlite"))
    )
    certificates = await relayCertificates()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await runtime.dispose()
    await rm(directory, { force: true, recursive: true })
  })

  // The certificates as a Relay starting on this state would have them.
  async function relayCertificates() {
    return new WebCertificates({
      resolve: async (hostname) => answers.get(hostname) ?? "missing",
      state: await runtime.runPromise(RelayStateStore),
      storePath: webCertificateStorePath(config),
    })
  }

  // What Traefik reads: the HTTPS router's TLS settings for the route.
  function routerTls(routes: ReadonlyArray<RelayStoredWebRoute> = [route]) {
    return parse(
      traefikDynamicConfiguration(config, routes, settings, certificates.gate())
    ).http.routers[routerName].tls
  }

  function asking() {
    return routerTls().certResolver === "kiln"
  }

  function advance(ms: number) {
    vi.setSystemTime(Date.now() + ms)
  }

  async function issue(...hostnames: Array<string>) {
    await writeFile(
      webCertificateStorePath(config),
      JSON.stringify({
        kiln: {
          Account: null,
          Certificates: hostnames.map((main) => ({
            certificate: "",
            domain: { main },
            key: "",
            Store: "default",
          })),
        },
      })
    )
  }

  it("asks for a new hostname's certificate once its name resolves, and again until it's issued", async () => {
    await certificates.track([route])
    // Before its record exists, Traefik serves its default certificate and
    // doesn't ask Let's Encrypt, which would answer NXDOMAIN.
    expect(routerTls()).toEqual({})
    await certificates.check()
    expect(asking()).toBe(false)
    expect(certificates.pending()).toEqual([
      {
        failed: true,
        hostname: "shop.example.com",
        owner: { id: "a".repeat(40), kind: "server" },
        waitingFor: "dns",
      },
    ])

    answers.set("shop.example.com", "found")
    advance(15 * second)
    await certificates.check()
    expect(routerTls()).toEqual({ certResolver: "kiln" })

    // Let's Encrypt didn't issue it, as when it remembered the name missing.
    // Traefik stops asking, so no other change to its routes asks for it.
    advance(90 * second)
    await certificates.check()
    expect(routerTls()).toEqual({})
    expect(certificates.pending()).toMatchObject([
      { failed: true, waitingFor: "certificate" },
    ])

    // Its retry has Traefik ask again.
    advance(2 * minute)
    await certificates.check()
    expect(asking()).toBe(true)

    await issue("shop.example.com")
    await certificates.check()
    expect(certificates.pending()).toEqual([])
    expect(asking()).toBe(true)
  })

  it("keeps a hostname's retries across a restart", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    await certificates.check()
    advance(90 * second)
    await certificates.check()
    expect(asking()).toBe(false)

    certificates = await relayCertificates()
    await certificates.track([route])
    await certificates.check()
    expect(asking()).toBe(false)
    expect(certificates.pending()).toMatchObject([
      { failed: true, waitingFor: "certificate" },
    ])

    advance(2 * minute)
    await certificates.check()
    expect(asking()).toBe(true)
  })

  it("asks within Let's Encrypt's hourly limit, however often someone checks", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    let asks = 0
    const start = Date.now()
    while (Date.now() - start < hour - minute) {
      const { asked } = await certificates.check("shop.example.com")
      if (asked) asks += 1
      advance(90 * second)
      await certificates.check()
      advance(30 * second)
    }

    expect(asks).toBe(4)
  })

  it("retries daily once a hostname has failed for a day", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    const start = Date.now()
    let lastAsk = start
    let gap = 0
    while (Date.now() - start < 3 * 24 * hour) {
      await certificates.check()
      if (asking()) {
        gap = Date.now() - lastAsk
        lastAsk = Date.now()
      }
      advance(5 * minute)
    }

    expect(gap).toBeGreaterThanOrEqual(24 * hour)
  })

  it("asks for a route's other names while one still waits for DNS", async () => {
    const both = { ...route, www: "serve" as const }
    answers.set("shop.example.com", "found")
    await certificates.track([both])
    await certificates.check()

    expect(routerTls([both])).toEqual({
      certResolver: "kiln",
      domains: [{ main: "shop.example.com" }],
    })
  })

  it("leaves routes that already have certificates as they were", async () => {
    await issue("shop.example.com")
    await certificates.track([route])

    expect(routerTls()).toEqual({ certResolver: "kiln" })
    expect(certificates.pending()).toEqual([])
  })
})
