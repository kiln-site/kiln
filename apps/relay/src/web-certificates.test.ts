import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { RelayProxySettings } from "@workspace/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { parse } from "yaml"

import type { RelayConfig } from "./config.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
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
const minute = 60_000

describe("bundled Traefik certificates", () => {
  let directory: string
  let config: RelayConfig
  let answers: Map<string, NameAnswer>
  let certificates: WebCertificates

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    directory = await mkdtemp(join(tmpdir(), "kiln-certificates-"))
    config = testRelayConfig(directory, { KILN_RELAY_PROXY: "traefik" })
    // Traefik's store, as the Relay creates it before Traefik first starts.
    await mkdir(dirname(webCertificateStorePath(config)), { recursive: true })
    await writeFile(webCertificateStorePath(config), "")
    answers = new Map()
    certificates = new WebCertificates({
      resolve: async (hostname) => answers.get(hostname) ?? "missing",
      storePath: webCertificateStorePath(config),
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(directory, { force: true, recursive: true })
  })

  // What Traefik reads.
  function traefik(routes: ReadonlyArray<RelayStoredWebRoute> = [route]) {
    return traefikDynamicConfiguration(
      config,
      routes,
      settings,
      certificates.gate()
    )
  }

  // The HTTPS router's TLS settings for the route.
  function routerTls(routes: ReadonlyArray<RelayStoredWebRoute> = [route]) {
    return parse(traefik(routes)).http.routers[routerName].tls
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

  it("asks for a new hostname's certificate only once its name resolves", async () => {
    await certificates.track([route])
    // Before its record exists, Traefik serves its default certificate and
    // doesn't ask Let's Encrypt, which would answer NXDOMAIN.
    expect(routerTls()).toEqual({})
    await certificates.check()
    expect(routerTls()).toEqual({})
    expect(certificates.pending()).toEqual([
      {
        failed: true,
        hostname: "shop.example.com",
        owner: { id: "a".repeat(40), kind: "server" },
        waitingFor: "dns",
      },
    ])

    answers.set("shop.example.com", "found")
    vi.setSystemTime(Date.now() + 15_000)
    await certificates.check()
    expect(routerTls()).toEqual({ certResolver: "kiln" })
    expect(certificates.pending()).toMatchObject([
      { failed: false, waitingFor: "certificate" },
    ])

    await issue("shop.example.com")
    await certificates.check()
    expect(certificates.pending()).toEqual([])
    expect(routerTls()).toEqual({ certResolver: "kiln" })
  })

  it("asks again when someone checks, a few times an hour for the whole Relay", async () => {
    const other: RelayStoredWebRoute = {
      ...route,
      hostname: "blog.example.com",
      id: "c00d4423",
    }
    answers.set("shop.example.com", "found")
    answers.set("blog.example.com", "found")
    await certificates.track([route, other])
    await certificates.check()
    // Let's Encrypt didn't issue them, and Traefik doesn't ask again on its own.
    vi.setSystemTime(Date.now() + 2 * minute)
    await certificates.check()
    expect(certificates.pending()).toMatchObject([
      { failed: true, waitingFor: "certificate" },
      { failed: true, waitingFor: "certificate" },
    ])

    // Each ask reaches every certificate Traefik lacks, so asks for either
    // hostname share one limit.
    const configurations = new Set([traefik([route, other])])
    let asks = 0
    for (let click = 0; click < 10; click += 1) {
      const hostname = click % 2 === 0 ? "shop.example.com" : "blog.example.com"
      const { asked } = await certificates.check(hostname)
      if (asked) {
        asks += 1
        // A changed configuration is what has Traefik ask again.
        expect(configurations.has(traefik([route, other]))).toBe(false)
        configurations.add(traefik([route, other]))
      }
      vi.setSystemTime(Date.now() + minute)
    }

    expect(asks).toBe(4)
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
