import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const id = "t".repeat(43)
const answer = "a".repeat(43)

// A Relay in Hearth mode, as one added without opening ports starts out.
async function hearthRelay() {
  process.env.HOSTNAME = "kiln-relay-under-test"
  onTestFinished(() => {
    delete process.env.HOSTNAME
    fakeDocker.reset()
  })
  const harness = await relayHarness({
    KILN_RELAY_HOST: "203.0.113.7",
    KILN_RELAY_TRAEFIK_IMAGE: "traefik:v3.6",
  })
  fakeDocker.addNetwork({ name: "bridge" })
  const relayContainer = fakeDocker.addContainer({
    image: "kiln-relay",
    name: "kiln-relay-under-test",
    networks: ["bridge"],
    running: true,
  })
  relayContainer.networks.set("bridge", {
    aliases: [],
    ipAddress: "172.17.0.2",
  })
  const traefik = () => fakeDocker.container(harness.resources.traefikContainer)
  const proxyFile = join(harness.config.dataDirectory, "proxy.json")
  return {
    dynamic: () =>
      readFile(
        join(
          harness.config.dataDirectory,
          "infrastructure/traefik/dynamic/kiln.yaml"
        ),
        "utf8"
      ),
    harness,
    publishListener: () => {
      relayContainer.portBindings["4100/tcp"] = [
        { HostIp: "0.0.0.0", HostPort: "4100" },
      ]
    },
    relayNetworks: () => [...relayContainer.networks.keys()],
    savedMode: async () =>
      (JSON.parse(await readFile(proxyFile, "utf8")) as { mode: string }).mode,
    start: () =>
      harness.lifecycle.startProxyTrial({ answer, id, upstreamTls: true }),
    traefik,
  }
}

it("stays in Hearth mode with nothing left behind when a trial ends", async () => {
  const relay = await hearthRelay()
  expect(await relay.start()).toBeNull()
  expect(relay.traefik()?.state.running).toBe(true)

  await relay.harness.lifecycle.stopProxyTrial(id)

  expect(relay.traefik()).toBeUndefined()
  expect(relay.harness.lifecycle.proxyTrialAnswer(id)).toBeNull()
  expect(await relay.savedMode()).toBe("hearth")
})

// Joining a network can take a Relay's live connections down with it, and
// Hearth's connection is what carries the trial.
it("leaves the Relay on the networks it was on, from start to finish", async () => {
  const relay = await hearthRelay()
  await relay.start()
  expect(relay.relayNetworks()).toEqual(["bridge"])
  expect(relay.traefik()?.networks.has("bridge")).toBe(true)

  await relay.harness.lifecycle.requestProxyTrialCertificate(id)
  await relay.harness.lifecycle.stopProxyTrial(id)

  expect(relay.relayNetworks()).toEqual(["bridge"])
})

it("doesn't leave Traefik on the Relay's network once committed", async () => {
  const relay = await hearthRelay()
  await relay.start()
  await relay.harness.lifecycle.requestProxyTrialCertificate(id)

  await relay.harness.lifecycle.commitProxyTrial(id)

  expect(relay.traefik()?.networks.has("bridge")).toBe(false)
  expect(relay.relayNetworks()).toEqual(["bridge"])
})

it("answers only the trial it's running", async () => {
  const relay = await hearthRelay()
  await relay.start()

  expect(relay.harness.lifecycle.proxyTrialAnswer(id)).toBe(answer)
  expect(relay.harness.lifecycle.proxyTrialAnswer("x".repeat(43))).toBeNull()
})

it("asks Let's Encrypt for nothing until the route is proven", async () => {
  const relay = await hearthRelay()
  await relay.start()
  expect(await relay.dynamic()).not.toContain("certResolver")
  expect(await relay.dynamic()).not.toContain("defaultGeneratedCert")

  await relay.harness.lifecycle.requestProxyTrialCertificate(id)

  expect(await relay.dynamic()).toContain("certResolver: kiln-ip")
})

it("won't commit a route that hasn't had its certificate requested", async () => {
  const relay = await hearthRelay()
  await relay.start()

  expect(await relay.harness.lifecycle.commitProxyTrial(id)).not.toBeNull()
  expect(await relay.savedMode()).toBe("hearth")
})

it("keeps Traefik and starts next in Traefik mode once committed", async () => {
  const relay = await hearthRelay()
  await relay.start()
  await relay.harness.lifecycle.requestProxyTrialCertificate(id)

  expect(await relay.harness.lifecycle.commitProxyTrial(id)).toBeNull()

  expect(await relay.savedMode()).toBe("traefik")
  expect(relay.traefik()?.state.running).toBe(true)
})

it("refuses a stale trial's steps once another took over", async () => {
  const relay = await hearthRelay()
  await relay.start()
  await relay.harness.lifecycle.stopProxyTrial(id)

  expect(
    await relay.harness.lifecycle.requestProxyTrialCertificate(id)
  ).not.toBeNull()
  expect(await relay.harness.lifecycle.commitProxyTrial(id)).not.toBeNull()
  expect(await relay.savedMode()).toBe("hearth")
})

// Traefik mode refuses to start with the listener published, so committing
// would leave a Relay that can't come back.
it("starts no trial when the Relay's listener is published", async () => {
  const relay = await hearthRelay()
  relay.publishListener()

  expect(await relay.start()).toContain("published")

  expect(relay.traefik()).toBeUndefined()
  expect(await relay.savedMode()).toBe("hearth")
})

it("can't be undone once committed, as by a late stop", async () => {
  const relay = await hearthRelay()
  await relay.start()
  await relay.harness.lifecycle.requestProxyTrialCertificate(id)
  await relay.harness.lifecycle.commitProxyTrial(id)

  await relay.harness.lifecycle.stopProxyTrial(id)

  expect(relay.traefik()?.state.running).toBe(true)
  expect(await relay.savedMode()).toBe("traefik")
})

it("starts no trial when something else holds port 80", async () => {
  const relay = await hearthRelay()
  fakeDocker.addContainer({
    image: "nginx",
    name: "someone-elses-proxy",
    running: true,
  }).portBindings["80/tcp"] = [{ HostIp: "", HostPort: "80" }]

  expect(await relay.start()).toContain("port 80")

  expect(relay.traefik()).toBeUndefined()
  expect(relay.harness.lifecycle.proxyTrialAnswer(id)).toBeNull()
  expect(await relay.savedMode()).toBe("hearth")
})
