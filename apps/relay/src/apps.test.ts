import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  appTailscaleMemberId,
  defaultAppConfig,
  relayTailscaleStackConfigSchema,
  relayDeployAppSchema,
  type AppConfig,
  type RelayApp,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { appRouteOwner } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const appId = "c".repeat(40)

afterEach(() => {
  vi.useRealTimers()
})

async function createdApp() {
  const harness = await relayHarness()
  await harness.apps.create({ id: appId, name: "Website" })
  fakeDocker.images.set("nginx:alpine", {})
  return harness
}

// Deploys and lets the new container settle, under fake timers, until the
// deployment finishes.
async function deploy(
  harness: RelayHarness,
  config: Partial<AppConfig>
): Promise<RelayApp> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  await harness.apps.deploy(
    relayDeployAppSchema.parse({
      appId,
      config: { ...defaultAppConfig, image: "nginx:alpine", ...config },
      name: "Website",
    })
  )
  // Docker and the filesystem are real I/O; each step lets them progress
  // before the clock moves on.
  for (let step = 0; step < 10_000; step += 1) {
    const app = await harness.apps.get(appId)
    if (app.deployment?.state !== "running") {
      vi.useRealTimers()
      return app
    }
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(100)
  }
  throw new Error("The deployment never finished")
}

function appContainers() {
  return [...fakeDocker.containers.values()].filter(
    (container) => container.labels["kiln.app.id"] === appId
  )
}

describe("apps", () => {
  it("deploys an image as one container named for the app and the time", async () => {
    const harness = await createdApp()

    const app = await deploy(harness, {
      environment: "GREETING=hello\n# comment\n",
      ports: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
    })

    expect(app).toMatchObject({
      deployment: { state: "succeeded" },
      observedState: "running",
    })
    const [container] = appContainers()
    expect(appContainers()).toHaveLength(1)
    expect(container!.name).toMatch(
      new RegExp(`^${TEST_NAMESPACE}-kiln-${appId.slice(0, 8)}-\\d{14}$`, "u")
    )
    expect(container!.state.running).toBe(true)
    expect(container!.env).toMatchObject({ GREETING: "hello" })
    expect(container!.labels).toMatchObject({
      "kiln.app.service": "app",
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "app",
    })
    expect(container!.mounts).toContainEqual(
      expect.objectContaining({
        destination: "/data",
        source: join(harness.config.dataDirectory, "apps", appId),
      })
    )
  })

  it("keeps the running container when its replacement fails to start", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const [previous] = appContainers()

    fakeDocker.failNext({ command: "start" }, "port is already allocated")
    const app = await deploy(harness, { command: "nginx -g 'daemon off;'" })

    expect(app.deployment).toMatchObject({ state: "failed" })
    expect(app.observedState).toBe("running")
    expect(appContainers().map((container) => container.id)).toEqual([
      previous!.id,
    ])
    expect(previous!.state.running).toBe(true)
  })

  it("keeps the latest deployment's log across a Relay restart", async () => {
    const harness = await createdApp()
    const deployed = await deploy(harness, {})

    const { apps } = await harness.restart()
    const app = await apps.get(appId)
    const session = await apps.consoleSession(appId, "deployment", () =>
      Promise.reject(new Error("Not a container stream"))
    )
    const history = await session.history()

    expect(app.deployment).toMatchObject({
      id: deployed.deployment!.id,
      state: "succeeded",
    })
    expect(history.lines.map((line) => line.text)).toContain(
      "Pulling nginx:alpine"
    )
  })

  it("labels a deployed container for its web routes on an external Traefik", async () => {
    const harness = await relayHarness({ KILN_RELAY_PROXY: "none" })
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.images.set("nginx:alpine", {})
    await Effect.runPromise(
      harness.state.replaceInstanceRoutes(appRouteOwner(appId), [
        {
          hostname: "site.example.com",
          id: "0a1b2c3d",
          name: "Site",
          path: null,
          service: "app",
          stripPrefix: true,
          targetPort: 80,
        },
      ])
    )

    await deploy(harness, {})

    const [container] = appContainers()
    expect(container!.labels).toMatchObject({
      "traefik.enable": "true",
      "traefik.http.routers.kiln-route-0a1b2c3d-https.rule":
        "Host(`site.example.com`)",
      "traefik.http.services.kiln-route-0a1b2c3d.loadbalancer.server.port":
        "80",
    })
    expect([...container!.networks.keys()]).toContain(
      harness.resources.edgeNetwork
    )
  })

  it("puts a service at its Tailscale address when the app deploys", async () => {
    const harness = await createdApp()
    const stackId = "e".repeat(40)
    const address = "10.165.57.12"
    const network = harness.resources.tailscaleStackNetwork(stackId)
    fakeDocker.addNetwork({
      labels: { "kiln.relay.owner": TEST_NAMESPACE },
      name: network,
      subnet: "10.165.57.0/24",
    })
    await mkdir(join(harness.config.rootDirectory, stackId), {
      recursive: true,
    })
    await writeFile(
      join(harness.config.rootDirectory, stackId, "stack.json"),
      JSON.stringify(
        relayTailscaleStackConfigSchema.parse({
          bindings: [
            {
              address,
              enabled: true,
              hostname: "website",
              instanceId: appTailscaleMemberId(appId, "app"),
            },
          ],
          domain: "test",
          hostname: "private-network",
          id: stackId,
          name: "Private Network",
          subnet: "10.165.57.0/24",
        })
      )
    )

    await deploy(harness, {})

    const [container] = appContainers()
    expect(container!.networks.get(network)).toMatchObject({
      ipAddress: address,
    })
  })

  it("removes an app's containers, network, and data when deleted", async () => {
    const harness = await createdApp()
    await deploy(harness, {})
    const data = join(harness.config.dataDirectory, "apps", appId)
    await writeFile(join(data, "notes.txt"), "keep me?")

    await harness.apps.delete({ appId, deleteData: true })

    expect(appContainers()).toEqual([])
    expect(
      [...fakeDocker.networks.values()].some(
        (network) => network.labels["kiln.app.id"] === appId
      )
    ).toBe(false)
    await expect(access(data)).rejects.toThrow()
    await expect(harness.apps.get(appId)).rejects.toThrow("App not found")
  })
})
