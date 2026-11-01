import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RelayProxySettings } from "@workspace/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { parse } from "yaml"

import type { RelayConfig } from "./config.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
import { testRelayConfig } from "./test/fixtures.js"
import { traefikDynamicConfiguration } from "./traefik.js"
import { WebCertificates, type NameAnswer } from "./web-certificates.js"

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

describe("bundled Traefik certificates", () => {
  let directory: string
  let config: RelayConfig
  let store: string
  let answers: Map<string, NameAnswer>
  let certificates: WebCertificates

  beforeEach(async () => {
    vi.useFakeTimers()
    directory = await mkdtemp(join(tmpdir(), "kiln-certificates-"))
    config = testRelayConfig(directory, { KILN_RELAY_PROXY: "traefik" })
    store = join(directory, "acme.json")
    // Traefik's store, as the Relay creates it before Traefik first starts.
    await writeFile(store, "")
    answers = new Map()
    certificates = new WebCertificates({
      resolve: async (hostname) => answers.get(hostname) ?? "missing",
      storePath: store,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(directory, { force: true, recursive: true })
  })

  // What Traefik reads: the HTTPS router's TLS settings for the route.
  function routerTls(routes: ReadonlyArray<RelayStoredWebRoute>) {
    const yaml = traefikDynamicConfiguration(
      config,
      routes,
      settings,
      certificates.gate()
    )
    return {
      tls: parse(yaml).http.routers[routerName].tls,
      yaml,
    }
  }

  async function issue(...hostnames: Array<string>) {
    await writeFile(
      store,
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
    expect(routerTls([route]).tls).toEqual({})
    await certificates.check()
    expect(routerTls([route]).tls).toEqual({})
    expect(certificates.pending()).toEqual([
      {
        failed: true,
        hostname: "shop.example.com",
        owner: { id: "a".repeat(40), kind: "server" },
        waitingFor: "dns",
      },
    ])

    answers.set("shop.example.com", "found")
    vi.advanceTimersByTime(15_000)
    expect(await certificates.check()).toEqual({ changed: true, rewrite: true })
    const asked = routerTls([route])
    expect(asked.tls).toEqual({ certResolver: "kiln" })
    expect(certificates.pending()).toMatchObject([
      { failed: false, waitingFor: "certificate" },
    ])

    // Let's Encrypt didn't issue it, as when it remembered the name missing:
    // Traefik's configuration changes, which has it ask again.
    vi.advanceTimersByTime(60_000)
    expect(await certificates.check()).toEqual({ changed: true, rewrite: true })
    const askedAgain = routerTls([route])
    expect(askedAgain.tls).toEqual({ certResolver: "kiln" })
    expect(askedAgain.yaml).not.toBe(asked.yaml)
    expect(certificates.pending()).toMatchObject([
      { failed: true, waitingFor: "certificate" },
    ])

    await issue("shop.example.com")
    await certificates.check()
    expect(certificates.pending()).toEqual([])
    expect(routerTls([route]).tls).toEqual({ certResolver: "kiln" })
  })

  it("asks for a route's other names while one still waits for DNS", async () => {
    const both = { ...route, www: "serve" as const }
    answers.set("shop.example.com", "found")
    await certificates.track([both])
    await certificates.check()

    expect(routerTls([both]).tls).toEqual({
      certResolver: "kiln",
      domains: [{ main: "shop.example.com" }],
    })

    answers.set("www.shop.example.com", "found")
    vi.advanceTimersByTime(15_000)
    await certificates.check()
    expect(routerTls([both]).tls).toEqual({ certResolver: "kiln" })
  })

  it("leaves routes that already have certificates as they were", async () => {
    await issue("shop.example.com")
    await certificates.track([route])

    expect(routerTls([route]).tls).toEqual({ certResolver: "kiln" })
    expect(certificates.pending()).toEqual([])
  })

  it("stops asking once a route's name stops resolving", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    await certificates.check()
    expect(routerTls([route]).tls).toEqual({ certResolver: "kiln" })

    answers.set("shop.example.com", "missing")
    vi.advanceTimersByTime(60_000)
    expect(await certificates.check()).toEqual({ changed: true, rewrite: true })
    expect(routerTls([route]).tls).toEqual({})
  })
})
