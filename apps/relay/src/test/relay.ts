/**
 * A Relay wired the way `index.ts` wires it — real drivers, real SQLite state,
 * a local file Brick catalog — with Docker replaced by `fakeDocker`.
 *
 * Test files must install the fake first:
 *
 *   vi.mock("./command.js", () => import("./test/docker.js"))
 *
 * The harness cleans itself up when the current test finishes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  appTailscaleMember,
  databaseTailscaleMemberId,
  instanceTailscaleMemberId,
  type RelayApp,
  type RelayInstance,
  type RelayManagedDatabase,
} from "@workspace/contracts"
import { Effect, ManagedRuntime } from "effect"
import { onTestFinished } from "vite-plus/test"

import { RelayVolumes } from "../volumes.js"
import { AppDriver } from "../apps.js"
import { BrickCatalog } from "../bricks.js"
import { loadConfig, type RelayConfig } from "../config.js"
import { ContainerCommands } from "../container-commands.js"
import { DatabaseConnections } from "../database-connections.js"
import { DatabaseDriver } from "../databases.js"
import { DockerDriver } from "../docker.js"
import { DockerEngine } from "../docker-engine.js"
import { makeRelayStateLayer, RelayStateStore } from "../effect/state.js"
import { LifecycleDriver } from "../lifecycle.js"
import { OperationLanes } from "../operation-lanes.js"
import { ResourceFreezes } from "../resource-freezes.js"
import { appRouteOwner, relayResourceNames } from "../relay-resources.js"
import { ResourcePower } from "../resource-power.js"
import { RuntimeRecoveryManager } from "../runtime-recovery.js"
import { ScheduleManager } from "../schedules.js"
import { type ContainerSeed, type FakeContainer, fakeDocker } from "./docker.js"

export const TEST_NAMESPACE = "kiln-test"

export interface RelayDrivers {
  readonly apps: AppDriver
  readonly bricks: BrickCatalog
  readonly commands: ContainerCommands
  readonly databaseConnections: DatabaseConnections
  readonly databases: DatabaseDriver
  readonly volumes: RelayVolumes
  readonly docker: DockerDriver
  readonly freezes: ResourceFreezes
  readonly lanes: OperationLanes
  readonly lifecycle: LifecycleDriver
  readonly power: ResourcePower<{
    app: RelayApp
    database: RelayManagedDatabase
    instance: RelayInstance
  }>
  readonly runtimeRecovery: RuntimeRecoveryManager
}

export interface RelayHarness extends RelayDrivers {
  readonly config: RelayConfig
  readonly resources: ReturnType<typeof relayResourceNames>
  readonly state: RelayStateStore["Service"]
  /** New drivers over the same data directory and SQLite file. */
  readonly restart: () => Promise<RelayDrivers>
  /**
   * Seeds a server container the way Relay creates one, for scenarios that
   * need state provisioning cannot produce (legacy labels, past sessions).
   */
  readonly seedServer: (input: ServerSeed) => Promise<FakeContainer>
}

export interface ServerSeed extends Partial<ContainerSeed> {
  readonly id: string
}

export async function relayHarness(
  environment: Record<string, string> = {}
): Promise<RelayHarness> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-relay-"))
  const catalogDirectory = join(dataDirectory, "catalog")
  await mkdir(catalogDirectory, { recursive: true })
  const catalog = join(catalogDirectory, "catalog.yml")
  await writeFile(catalog, "format: kiln.catalog/v1\nrecipes: []\n")
  const config = loadConfig({
    KILN_BRICKS_CATALOG_URL: pathToFileURL(catalog).href,
    KILN_RELAY_DATA_DIR: dataDirectory,
    KILN_RELAY_HOST: "relay.test",
    KILN_RELAY_PROXY: "hearth",
    KILN_RELAY_RESOURCE_NAMESPACE: TEST_NAMESPACE,
    NODE_ENV: "test",
    ...environment,
  })
  config.dockerSocket = await fakeDocker.listen()
  await mkdir(config.rootDirectory, { recursive: true })

  const runtime = ManagedRuntime.make(
    makeRelayStateLayer(join(dataDirectory, "relay.sqlite"))
  )
  const state = await runtime.runPromise(RelayStateStore)
  const resources = relayResourceNames(config)

  const drivers = async (): Promise<RelayDrivers> => {
    const bricks = new BrickCatalog(config.brickCatalogUrl, dataDirectory)
    const freezes = await Effect.runPromise(ResourceFreezes.load(state))
    const lanes = new OperationLanes({ frozen: freezes })
    const runtimeRecovery = new RuntimeRecoveryManager(config, state, lanes)
    await Effect.runPromise(runtimeRecovery.initialize())
    const databaseConnections = new DatabaseConnections(config, state)
    const docker = new DockerDriver(
      config,
      runtimeRecovery,
      bricks,
      state,
      databaseConnections,
      lanes
    )
    const lifecycle = new LifecycleDriver(
      config,
      docker,
      bricks,
      databaseConnections,
      lanes
    )
    lifecycles.push(lifecycle)
    // What a deployment's external volumes are, as the Relay's own finds.
    const volumes = new RelayVolumes(
      config,
      new DockerEngine(config.dockerSocket),
      state,
      () => lifecycle.hostDataDirectory()
    )
    const apps = new AppDriver(
      config,
      () => lifecycle.hostDataDirectory(),
      {
        reattachTailscale: (appId) =>
          lifecycle.reattachTailscaleMembers(
            (memberId) => appTailscaleMember(memberId)?.appId === appId
          ),
        routes: async (appId) =>
          lifecycle.appRoutePlan(
            await Effect.runPromise(
              state.listInstanceRoutes(appRouteOwner(appId))
            )
          ),
        tailscale: async (appId) =>
          (
            await lifecycle.tailscaleMemberships(
              (memberId) => appTailscaleMember(memberId)?.appId === appId
            )
          ).map((membership) => ({
            ...membership,
            service: appTailscaleMember(membership.memberId)!.service,
          })),
      },
      lanes,
      { allocations: docker.allocations, state },
      databaseConnections,
      (dockerNames) => Effect.runPromise(volumes.idsByDockerName(dockerNames))
    )
    lifecycle.useAppServiceContainers(async (appId, service) => {
      await apps.get(appId)
      return (await apps.serviceContainer(appId, service))?.name ?? null
    })
    const databases = new DatabaseDriver(config, docker, databaseConnections)
    lifecycle.useDatabaseContainers((databaseId) =>
      databases.containerOf(databaseId)
    )
    runtimeRecovery.useTailscaleAddresses((instanceId) =>
      lifecycle.reattachTailscaleMember(instanceTailscaleMemberId(instanceId))
    )
    databases.useTailscaleAddresses((databaseId) =>
      lifecycle.reattachTailscaleMember(databaseTailscaleMemberId(databaseId))
    )
    return {
      volumes,
      apps,
      bricks,
      commands: new ContainerCommands({
        apps,
        databases,
        engine: new DockerEngine(config.dockerSocket),
        lanes,
      }),
      databaseConnections,
      databases,
      docker,
      freezes,
      lanes,
      lifecycle,
      power: new ResourcePower({
        adapters: {
          app: (appId, action) => apps.action({ action, appId }),
          database: (databaseId, action) =>
            databases.action({ action, databaseId }),
          instance: async (instanceId, action) => {
            const instance = await docker.findInstance(instanceId)
            if (!instance) throw new Error("Instance not found")
            const [routes, pendingPrimaryPort] = await Effect.runPromise(
              Effect.all([
                state.listInstanceRoutes(instanceId),
                state.getPendingPrimaryPort(instanceId),
              ])
            )
            return lifecycle.runInstanceAction(
              instance,
              action,
              routes,
              pendingPrimaryPort
            )
          },
        },
        lanes,
        replacements: { app: (appId) => apps.replacements(appId) },
      }),
      runtimeRecovery,
    }
  }
  const lifecycles: Array<LifecycleDriver> = []

  onTestFinished(async () => {
    for (const lifecycle of lifecycles) lifecycle.close()
    await runtime.dispose()
    await rm(dataDirectory, { force: true, recursive: true })
    fakeDocker.reset()
  })

  return {
    ...(await drivers()),
    config,
    resources,
    state,
    restart: drivers,
    seedServer: async ({ id, labels, ...seed }) => {
      const directory = join(config.rootDirectory, id)
      await mkdir(directory, { recursive: true })
      if (!fakeDocker.networks.has(resources.gameNetwork)) {
        fakeDocker.addNetwork({
          labels: {
            "kiln.relay.network": "game",
            "kiln.relay.owner": TEST_NAMESPACE,
          },
          name: resources.gameNetwork,
        })
      }
      return fakeDocker.addContainer({
        memoryBytes: 512 * 1024 ** 2,
        mounts: [{ destination: "/server", source: directory, type: "bind" }],
        name: resources.instanceContainer(id),
        networks: [resources.gameNetwork],
        ...seed,
        labels: {
          "kiln.instance.directory": id,
          "kiln.instance.disk-bytes": String(1024 ** 3),
          "kiln.instance.memory-bytes": String(512 * 1024 ** 2),
          "kiln.instance.mount": "/server",
          "kiln.relay.managed": "true",
          "kiln.relay.owned": "true",
          "kiln.relay.owner": TEST_NAMESPACE,
          "kiln.server.id": id,
          ...labels,
        },
      })
    },
  }
}

/**
 * The Relay's schedule worker over a harness's drivers, wired as index.ts
 * wires it. It stops when the test finishes.
 */
export async function scheduleWorker(harness: RelayHarness) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-relay-schedules-"))
  const manager = await ScheduleManager.make({
    enqueueBackup: async () => {
      throw new Error("not used")
    },
    findInstance: (instanceId) => harness.docker.findInstance(instanceId),
    getBackup: async () => null,
    isPaused: () => harness.lanes.paused,
    listAppOwnedVolumeIds: (appId) =>
      Effect.runPromise(harness.volumes.ownedAppVolumeIds(appId)),
    listAppIds: async () =>
      new Set((await harness.apps.list()).map(({ id }) => id)),
    listDatabaseIds: async () =>
      new Set((await harness.databases.list()).map(({ id }) => id)),
    platformTargetId: () => "platform",
    powerIntent: (kind, id) => harness.power.intent(kind, id),
    relayId: "relay-a",
    runContainerCommand: (target, command) =>
      harness.commands.run(target, command),
    runPower: (kind, id, action, powerIntent) =>
      harness.power.scheduled(kind, id, action, powerIntent),
    sendConsoleCommand: async () => {
      throw new Error("not used")
    },
    state: harness.state.schedules,
    stateDirectory: directory,
  })
  onTestFinished(async () => {
    manager.close()
    await rm(directory, { force: true, recursive: true })
  })
  return manager
}
