import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  defaultAppConfig,
  relayDeployAppSchema,
  type AppConfig,
  type RelayApp,
} from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

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
  for (let step = 0; step < 50; step += 1) {
    const app = await harness.apps.get(appId)
    if (app.deployment?.state !== "running") {
      vi.useRealTimers()
      return app
    }
    await vi.advanceTimersByTimeAsync(1_000)
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
