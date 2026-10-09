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
  brickRecipeSchema,
  relayCreateInstanceSchema,
  type BrickRecipe,
  type RelayInstance,
} from "@workspace/contracts"
import { Effect, ManagedRuntime } from "effect"
import { onTestFinished } from "vite-plus/test"

import { AppDriver } from "../apps.js"
import { BrickCatalog } from "../bricks.js"
import { loadConfig, type RelayConfig } from "../config.js"
import { DatabaseConnections } from "../database-connections.js"
import { DatabaseDriver } from "../databases.js"
import { DockerDriver } from "../docker.js"
import { makeRelayStateLayer, RelayStateStore } from "../effect/state.js"
import { LifecycleDriver } from "../lifecycle.js"
import { relayResourceNames } from "../relay-resources.js"
import { RuntimeRecoveryManager } from "../runtime-recovery.js"
import { type ContainerSeed, type FakeContainer, fakeDocker } from "./docker.js"

export const TEST_NAMESPACE = "kiln-test"

export interface RelayDrivers {
  readonly apps: AppDriver
  readonly bricks: BrickCatalog
  readonly databaseConnections: DatabaseConnections
  readonly databases: DatabaseDriver
  readonly docker: DockerDriver
  readonly lifecycle: LifecycleDriver
  readonly runtimeRecovery: RuntimeRecoveryManager
}

export interface RelayHarness extends RelayDrivers {
  readonly config: RelayConfig
  readonly resources: ReturnType<typeof relayResourceNames>
  readonly state: RelayStateStore["Service"]
  /** New drivers over the same data directory and SQLite file. */
  readonly restart: () => Promise<RelayDrivers>
  /** Publishes a recipe in the local catalog and returns its source URL. */
  readonly publishRecipe: (recipe: BrickRecipe) => Promise<string>
  /**
   * Seeds a server container the way Relay creates one, for scenarios that
   * need state provisioning cannot produce (legacy labels, past sessions).
   */
  readonly seedServer: (input: ServerSeed) => Promise<FakeContainer>
  /** Provisions a server through Relay's real create path. */
  readonly createServer: (input: {
    id: string
    recipe?: BrickRecipe
    start?: boolean
    variables?: Record<string, string>
  }) => Promise<RelayInstance>
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
    const runtimeRecovery = new RuntimeRecoveryManager(config, state)
    await Effect.runPromise(runtimeRecovery.initialize())
    const databaseConnections = new DatabaseConnections(config, state)
    const docker = new DockerDriver(
      config,
      runtimeRecovery,
      bricks,
      state,
      databaseConnections
    )
    const lifecycle = new LifecycleDriver(
      config,
      docker,
      bricks,
      databaseConnections
    )
    lifecycles.push(lifecycle)
    return {
      apps: new AppDriver(config, () => lifecycle.hostDataDirectory()),
      bricks,
      databaseConnections,
      databases: new DatabaseDriver(config, docker, databaseConnections),
      docker,
      lifecycle,
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

  const initial = await drivers()
  const publishRecipe = async (recipe: BrickRecipe) => {
    const path = join(catalogDirectory, `${recipe.metadata.id}.json`)
    await writeFile(path, JSON.stringify(recipe))
    return pathToFileURL(path).href
  }
  return {
    ...initial,
    config,
    resources,
    state,
    restart: drivers,
    publishRecipe,
    createServer: async ({
      id,
      recipe = serverRecipe(),
      start = false,
      variables = {},
    }) =>
      initial.lifecycle.createInstanceWithId(
        id,
        relayCreateInstanceSchema.parse({
          diskLimitBytes: 1024 ** 3,
          recipe: await publishRecipe(recipe),
          start,
          variables,
        })
      ),
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

/** A small direct-networked Brick with one TCP game port. */
export function serverRecipe(
  overrides: Partial<BrickRecipe> = {}
): BrickRecipe {
  return brickRecipeSchema.parse({
    format: "kiln.brick/v1",
    metadata: {
      author: "Kiln",
      description: "A test Brick recipe.",
      game: "Example Game",
      id: "example",
      name: "Example",
    },
    network: {
      hostname: "{{ brick.id }}",
      mode: "direct",
      ports: [{ container: 25_565, name: "game", protocol: "tcp" }],
      primaryPort: "game",
    },
    runtime: {
      environment: { VERSION: "{{ variables.version }}" },
      image: "registry.example.com/example/server:{{ variables.version }}",
      name: "Example {{ variables.version }}",
      resources: { memory: "512M", memoryReservation: "512M", pids: 128 },
      storage: { mount: "/server" },
    },
    variables: {
      version: {
        default: "1.2.3",
        description: "Release to install.",
        label: "Version",
        required: true,
        rules: { pattern: "^[0-9.]+$" },
        type: "string",
      },
    },
    ...overrides,
  })
}
