import "reflect-metadata"

import { X509Certificate as NodeX509Certificate, webcrypto } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promises as dnsCodes } from "node:dns"
import { dirname, join } from "node:path"

import {
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509"
import type { RelayProxySettings } from "@workspace/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { parse } from "yaml"

import type { RelayConfig } from "./config.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
import { testRelayConfig } from "./test/fixtures.js"
import { traefikDynamicConfiguration } from "./traefik.js"
import {
  nameResolver,
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
  instanceId: "a".repeat(12),
  name: "Shop",
  path: null,
  redirect: null,
  stripPrefix: false,
  targetPort: 8080,
  www: "none",
}

const routerName = "kiln-route-b00d4423"
const owner = { id: "a".repeat(12), kind: "server" as const }
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
        owner: { id: "a".repeat(12), kind: "server" },
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

  // A name being moved here resolves to where it's moved from, and Let's
  // Encrypt would check that. Traefik asks once, and not again when it fails,
  // as it does while the changed record is still on its way round.
  it("asks for a moved hostname's certificate once it points here, and again while it's missing", async () => {
    answers.set("shop.example.com", "found")
    certificates.hold(["shop.example.com"])
    await certificates.track([route])
    await certificates.check()
    expect(routerTls()).toEqual({})

    certificates.release(["shop.example.com"])
    await certificates.check()
    expect(routerTls()).toEqual({})
    vi.setSystemTime(Date.now() + 15_000)
    await certificates.check()
    expect(routerTls()).toEqual({ certResolver: "kiln" })

    // Never issued, it's asked for a few more times, then left to someone.
    const configurations = new Set([traefik()])
    for (let passed = 0; passed < 30; passed += 1) {
      vi.setSystemTime(Date.now() + minute)
      await certificates.check()
      configurations.add(traefik())
    }
    expect(configurations.size).toBe(4)
  })

  // A record that only changes later, as once its Relay can serve, is asked
  // for then, whatever was asked while it pointed elsewhere.
  it("asks again for a hostname refused while its record pointed elsewhere", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    await certificates.check()
    const refused = traefik()
    vi.setSystemTime(Date.now() + 3 * 60 * minute)
    await certificates.check()
    expect(certificates.pending()).toMatchObject([{ failed: true }])

    certificates.release(["shop.example.com"])
    expect(certificates.pending()).toMatchObject([{ failed: false }])
    vi.setSystemTime(Date.now() + minute)
    await certificates.check()
    expect(traefik()).not.toEqual(refused)
  })

  it("asks for a certificate for each of a public database's names once it resolves, and finds each by its leaf", async () => {
    const database = {
      databaseId: "b".repeat(12),
      hostnames: ["db.example.com", "data.example.com"],
    }
    const router = `kiln-database-${database.databaseId}`
    const routers = () =>
      parse(
        traefikDynamicConfiguration(config, [], settings, certificates.gate(), [
          database,
        ])
      ).http.routers
    await certificates.track([], [database])
    expect(routers()?.[router]).toBeUndefined()
    expect(certificates.pending()).toMatchObject([
      {
        owner: { id: database.databaseId, kind: "database" },
        waitingFor: "dns",
      },
      {
        owner: { id: database.databaseId, kind: "database" },
        waitingFor: "dns",
      },
    ])

    // A name never set up doesn't hold back the others'.
    answers.set("db.example.com", "found")
    vi.setSystemTime(Date.now() + 15_000)
    await certificates.check()
    expect(routers()?.[router]).toMatchObject({
      rule: "Host(`db.example.com`)",
      tls: { certResolver: "kiln", domains: [{ main: "db.example.com" }] },
    })

    answers.set("data.example.com", "found")
    vi.setSystemTime(Date.now() + 15_000)
    await certificates.check()
    expect(routers()?.[router]).toMatchObject({
      rule: "Host(`db.example.com`) || Host(`data.example.com`)",
      tls: {
        certResolver: "kiln",
        domains: [{ main: "db.example.com" }, { main: "data.example.com" }],
      },
    })

    // Each name gets the certificate whose leaf names it that runs out
    // last, whatever Traefik's store says it's for: it can list fewer names
    // than the certificate has. A wildcard's serves, and one that's run out
    // never does.
    const keys = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    )) as webcrypto.CryptoKeyPair
    const key = Buffer.from(
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
        await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)
      ).toString("base64")}\n-----END PRIVATE KEY-----\n`
    ).toString("base64")
    const day = 24 * 60 * minute
    const store = async (
      ...held: Array<{ days: number; listed: string; names: Array<string> }>
    ) =>
      writeFile(
        webCertificateStorePath(config),
        JSON.stringify({
          kiln: {
            Account: null,
            Certificates: await Promise.all(
              held.map(async ({ days, listed, names }) => ({
                certificate: Buffer.from(
                  (
                    await X509CertificateGenerator.createSelfSigned(
                      {
                        extensions: [
                          new SubjectAlternativeNameExtension(
                            names.map((value) => ({ type: "dns", value }))
                          ),
                        ],
                        keys,
                        name: `CN=${names.join(" ")} for ${days}`,
                        notAfter: new Date(Date.now() + days * day),
                        notBefore: new Date(Date.now() - 60 * day),
                        serialNumber: "01",
                        signingAlgorithm: { hash: "SHA-256", name: "ECDSA" },
                      },
                      webcrypto
                    )
                  ).toString("pem")
                ).toString("base64"),
                domain: { main: listed },
                key,
                Store: "default",
              }))
            ),
          },
        })
      )
    await store(
      { days: 20, listed: "*.example.com", names: ["*.example.com"] },
      {
        days: 60,
        listed: "shop.example.com",
        names: ["shop.example.com", "db.example.com"],
      },
      { days: -1, listed: "data.example.com", names: ["data.example.com"] }
    )
    const given = await certificates.certificates(database.hostnames)
    expect(
      given?.map((held) =>
        held ? new NodeX509Certificate(held.chain).subject : null
      )
    ).toEqual([
      "CN=shop.example.com db.example.com for 60",
      "CN=*.example.com for 20",
    ])
    expect(await certificates.certificates(["db.example.org"])).toEqual([null])

    // Caught partway through Traefik writing it, the store says nothing.
    await writeFile(webCertificateStorePath(config), '{"kiln": {"Certific')
    expect(await certificates.certificates(database.hostnames)).toBeNull()
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
      const { asked } = await certificates.check({ hostname, owner })
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

  it("refuses a check of a hostname another resource's route serves", async () => {
    answers.set("shop.example.com", "found")
    await certificates.track([route])
    await certificates.check()
    const before = traefik()

    await expect(
      certificates.check({
        hostname: "shop.example.com",
        owner: { id: "b".repeat(12), kind: "server" },
      })
    ).rejects.toThrow("No route of this game server serves shop.example.com")
    expect(traefik()).toBe(before)
  })

  it("asks again only for someone checking, not a background check that overlapped them", async () => {
    await certificates.track([route])
    answers.set("shop.example.com", "found")
    // The background check looks the name up outside the routes lane…
    const background = await certificates.lookUp()
    // …while someone checks it by hand, which has Traefik ask for it.
    expect(
      (await certificates.check({ hostname: "shop.example.com", owner })).asked
    ).toBe(true)
    const asked = traefik()

    // Applied in its turn, the background check asks again for nothing.
    const result = await certificates.apply(background)
    expect(result.asked).toBe(false)
    expect(traefik()).toBe(asked)
  })
})

describe("checking a name at its own nameservers", () => {
  const fail = (code: string) => Object.assign(new Error(code), { code })
  // Each zone's nameservers, and what each nameserver answers.
  const zones: Record<string, ReadonlyArray<string>> = {
    "co.uk": ["ns.registry.uk"],
    "example.co.uk": ["ns.example.co.uk"],
    "example.com": ["ns.example.com"],
  }
  const answers: Record<string, ReadonlyArray<string> | string> = {
    "ns.example.co.uk example.co.uk A": ["192.0.2.2"],
    "ns.example.com new.example.com A": dnsCodes.NOTFOUND,
    "ns.example.com shop.example.com A": ["192.0.2.1"],
  }
  const resolve = nameResolver({
    addresses: async (host) => [host],
    nameservers: async (name) => {
      const servers = zones[name]
      if (!servers) throw fail(dnsCodes.NOTFOUND)
      return servers
    },
    records: async (servers, name, type) => {
      const answer = answers[`${servers.join(",")} ${name} ${type}`]
      // Anything else exists without such a record, or is only referred on.
      if (answer === undefined) throw fail(dnsCodes.NODATA)
      if (typeof answer === "string") throw fail(answer)
      return answer
    },
  })

  it.each([
    ["finds a name its zone answers for", "shop.example.com", "found"],
    [
      "waits for a name its zone doesn't have yet",
      "new.example.com",
      "missing",
    ],
    ["asks a zone its parent only refers to", "example.co.uk", "found"],
  ] as const)("%s", async (_, hostname, expected) => {
    expect(await resolve(hostname)).toBe(expected)
  })
})
