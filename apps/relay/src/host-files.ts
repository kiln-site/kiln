import { access, constants, readFile, rm, stat } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, extname, join } from "node:path"
import type { RelayHostFiles } from "@workspace/contracts"
import { Effect, Schedule } from "effect"

import type { RelayConfig } from "./config.js"
import { DockerEngine, isDockerNotFound } from "./docker-engine.js"
import { recoverPromise } from "./effect/promise.js"
import { HostAccessDisabledError } from "./host-shell.js"
import {
  isDockerGeneratedHostname,
  networkAliases,
  type ContainerInspect,
} from "./update-container.js"

const HELPER_LABEL = "io.kiln.host-files-helper"

type HostFilesConfig = Pick<
  RelayConfig,
  | "dataDirectory"
  | "dockerSocket"
  | "hostAccess"
  | "hostRootDirectory"
  | "resourceNamespace"
>

// The Files page reads the Relay's host through its filesystem mounted at the
// host root. Mounting it is a change to the Relay's own container, so a
// short-lived helper beside it recreates the Relay with the mount.
export class HostFiles {
  readonly #config: HostFilesConfig
  readonly #engine: DockerEngine
  readonly #helperName: string
  readonly #resultPath: string

  constructor(config: HostFilesConfig) {
    this.#config = config
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#helperName = config.resourceNamespace
      ? `${config.resourceNamespace}-kiln-host-files-mount`
      : "kiln-host-files-mount"
    this.#resultPath = join(config.dataDirectory, "host-files-mount.json")
  }

  async status(): Promise<RelayHostFiles> {
    if (!this.#config.hostAccess) {
      return { status: "disabled", limitation: null, mountError: null }
    }
    if (await this.#mounted()) {
      return {
        status: "ready",
        limitation: await this.#limitation(),
        mountError: null,
      }
    }
    if (await this.#helperRunning()) {
      return { status: "mounting", limitation: null, mountError: null }
    }
    return {
      status: "unmounted",
      limitation: null,
      mountError: await this.#lastMountError(),
    }
  }

  // Starts the helper, which stops this Relay once it has answered.
  async mount(): Promise<void> {
    if (!this.#config.hostAccess) throw new HostAccessDisabledError()
    if ((await this.#mounted()) || (await this.#helperRunning())) return
    const relay = await Effect.runPromise(
      this.#engine.inspectContainer<ContainerInspect>(hostname())
    )
    const securityOptions = await this.#securityOptions()
    await rm(this.#resultPath, { force: true })
    await Effect.runPromise(
      this.#engine.removeContainer(this.#helperName, { force: true })
    )
    // Beside the Relay's own entry, which is TypeScript in development.
    const main = process.argv[1] ?? ""
    const development = extname(main) === ".ts"
    const entry = join(dirname(main), `host-files-helper${extname(main)}`)
    const helper = await Effect.runPromise(
      this.#engine.createContainer(this.#helperName, {
        // The Relay's own image and volumes, so the helper runs this code.
        Image: relay.Image,
        Entrypoint: [process.execPath],
        Cmd: [...(development ? ["--import", "tsx"] : []), entry],
        WorkingDir: process.cwd(),
        Env: [
          `KILN_HOST_FILES_RELAY=${relay.Id}`,
          `KILN_HOST_FILES_ROOT=${this.#config.hostRootDirectory}`,
          `KILN_HOST_FILES_RESULT=${this.#resultPath}`,
          `KILN_HOST_FILES_DOCKER_SOCKET=${this.#config.dockerSocket}`,
          // SELinux would keep the Relay from reading most host files.
          `KILN_HOST_FILES_DISABLE_LABEL=${securityOptions.has("selinux") ? "1" : ""}`,
        ],
        Healthcheck: { Test: ["NONE"] },
        Labels: { [HELPER_LABEL]: "true" },
        HostConfig: {
          AutoRemove: true,
          NetworkMode: "none",
          VolumesFrom: [relay.Id],
        },
      })
    )
    await Effect.runPromise(this.#engine.startContainer(helper.Id))
  }

  #mounted(): Promise<boolean> {
    return recoverPromise(
      async () => (await stat(this.#config.hostRootDirectory)).isDirectory(),
      () => false
    )
  }

  // Why the Relay can't read or change some host files, when it can tell.
  async #limitation(): Promise<RelayHostFiles["limitation"]> {
    const securityOptions = await this.#securityOptions()
    if (securityOptions.has("rootless")) return "rootless"
    if (securityOptions.has("userns")) return "user-namespace"
    if (process.getuid?.() !== 0) return "non-root"
    const label = await recoverPromise(
      () => readFile("/proc/self/attr/current", "utf8"),
      () => ""
    )
    if (label.includes(":container_t:")) return "selinux"
    const readOnly = await recoverPromise(
      async () => {
        await access(this.#config.hostRootDirectory, constants.W_OK)
        return false
      },
      (cause) => (cause as NodeJS.ErrnoException).code === "EROFS"
    )
    return readOnly ? "read-only" : null
  }

  // Names of the daemon's security options, such as rootless and selinux.
  async #securityOptions(): Promise<ReadonlySet<string>> {
    const info = await recoverPromise(
      () => Effect.runPromise(this.#engine.info()),
      () => null
    )
    return new Set(
      (info?.SecurityOptions ?? []).map(
        (option) => option.split(",")[0]?.replace(/^name=/u, "") ?? ""
      )
    )
  }

  async #helperRunning(): Promise<boolean> {
    const helper = await Effect.runPromise(
      this.#engine
        .inspectContainer<ContainerInspect>(this.#helperName)
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.succeed(null)))
    )
    return helper?.State.Running ?? false
  }

  async #lastMountError(): Promise<string | null> {
    return recoverPromise(
      async () =>
        (JSON.parse(await readFile(this.#resultPath, "utf8")) as MountResult)
          .error,
      () => null
    )
  }
}

export interface MountResult {
  readonly error: string
}

// Recreates the Relay's container with the host's filesystem mounted at
// `root`, keeping everything else. The Relay is renamed aside rather than
// removed, and put back if its replacement doesn't start.
export const mountHostFilesEffect = Effect.fn("relay.hostFiles.mount")(
  function* (
    engine: DockerEngine,
    input: { relay: string; root: string; disableLabel: boolean }
  ) {
    const current = yield* engine.inspectContainer<ContainerInspect>(
      input.relay
    )
    const mounts = (current.HostConfig.Mounts ?? []) as Array<{
      Target?: string
    }>
    if (mounts.some((mount) => mount.Target === input.root)) return
    const name = current.Name.replace(/^\//u, "")
    const replace = (propagation: "rprivate" | "rslave") =>
      replacementEffect(engine, current, name, { ...input, propagation })
    // Puts the original Relay back under its name and starts it.
    const restore = Effect.gen(function* () {
      const occupant = yield* engine
        .inspectContainer<ContainerInspect>(name)
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.succeed(null)))
      if (occupant?.Id === current.Id) {
        return yield* engine.startContainer(current.Id)
      }
      if (occupant) yield* engine.removeContainer(occupant.Id, { force: true })
      yield* engine.renameContainer(current.Id, name)
      yield* engine.startContainer(current.Id)
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not put the Relay back", cause)
      )
    )

    yield* engine.stopContainer(current.Id, { seconds: 30, timeout: 45_000 })
    yield* Effect.gen(function* () {
      yield* engine.renameContainer(
        current.Id,
        `${name}-kiln-backup-${Date.now()}`
      )
      yield* replace("rslave").pipe(
        // Docker only shares the host's later mounts with the Relay where the
        // host's root is a shared mount; elsewhere, mount it without them.
        Effect.catchIf(
          (cause) => cause.message.includes("not a shared or slave mount"),
          () => replace("rprivate")
        )
      )
    }).pipe(Effect.tapError(() => restore))
    yield* engine.removeContainer(current.Id, { force: true })
  }
)

function replacementEffect(
  engine: DockerEngine,
  current: ContainerInspect,
  name: string,
  input: {
    disableLabel: boolean
    propagation: "rprivate" | "rslave"
    root: string
  }
) {
  return Effect.gen(function* () {
    // A failed earlier attempt may have left its replacement.
    yield* engine.removeContainer(name, { force: true })
    const networks = current.NetworkSettings?.Networks ?? {}
    const networkNames = Object.keys(networks)
    const configured = current.HostConfig.NetworkMode
    const primary =
      configured && Object.hasOwn(networks, configured)
        ? configured
        : networkNames[0]
    const config = { ...current.Config }
    // Docker names a container's host after its ID; the replacement gets its
    // own.
    if (isDockerGeneratedHostname(config.Hostname, current.Id)) {
      delete config.Hostname
    }
    const securityOptions = (current.HostConfig.SecurityOpt ??
      []) as Array<string>
    const created = yield* engine.createContainer(name, {
      ...config,
      HostConfig: {
        ...current.HostConfig,
        Mounts: [
          ...namedVolumeMounts(current),
          {
            Type: "bind",
            Source: "/",
            Target: input.root,
            BindOptions: { Propagation: input.propagation },
          },
        ],
        ...(input.disableLabel && {
          SecurityOpt: [...securityOptions, "label=disable"],
        }),
      },
      ...(primary && {
        NetworkingConfig: {
          EndpointsConfig: {
            [primary]: userDefinedNetwork(primary)
              ? { Aliases: networkAliases(networks[primary]?.Aliases, name) }
              : {},
          },
        },
      }),
    })
    yield* Effect.forEach(
      networkNames.filter((network) => network !== primary),
      (network) =>
        engine.connectNetwork(
          network,
          created.Id,
          userDefinedNetwork(network)
            ? { aliases: networkAliases(networks[network]?.Aliases, name) }
            : {}
        ),
      { discard: true }
    )
    yield* engine.startContainer(created.Id, { timeout: 120_000 })
    yield* untilHealthy(engine, created.Id)
  })
}

// The Relay's mounts, with each volume given by name. Docker names a volume
// itself when only its path is configured, as with `-v /data` or an image's
// VOLUME, and would give the replacement a new, empty one: the Relay's state
// would stay behind in the old volume.
function namedVolumeMounts(current: ContainerInspect): Array<unknown> {
  const mounts = (current.HostConfig.Mounts ?? []) as Array<{
    Source?: string
    Target: string
    Type?: string
  }>
  const bound = ((current.HostConfig.Binds ?? []) as Array<string>).map(
    (bind) => bind.split(":")[1]
  )
  const volumes = new Map(
    (current.Mounts ?? [])
      .filter((mount) => mount.Type === "volume" && mount.Name)
      .map((mount) => [mount.Destination, mount])
  )
  const named = mounts.map((mount) => {
    const volume = volumes.get(mount.Target)
    return mount.Type === "volume" && !mount.Source && volume
      ? { ...mount, Source: volume.Name }
      : mount
  })
  const unlisted = [...volumes.values()]
    .filter(
      (volume) =>
        !bound.includes(volume.Destination) &&
        !mounts.some((mount) => mount.Target === volume.Destination)
    )
    .map((volume) => ({
      Type: "volume",
      Source: volume.Name,
      Target: volume.Destination,
      ReadOnly: volume.RW === false,
    }))
  return [...named, ...unlisted]
}

// Docker's own bridge, host, and none networks take no aliases.
function userDefinedNetwork(network: string): boolean {
  return (
    !["bridge", "host", "none"].includes(network) &&
    !network.startsWith("container:")
  )
}

// Passes once the replacement's health check does, or at once without one.
function untilHealthy(engine: DockerEngine, id: string) {
  return engine.inspectContainer<ContainerInspect>(id).pipe(
    Effect.flatMap((container) => {
      if (!container.State.Running) {
        return Effect.fail(new Error("The Relay stopped while starting"))
      }
      const health = container.State.Health?.Status
      if (health === "unhealthy") {
        return Effect.fail(new Error("The Relay failed its health check"))
      }
      return Effect.succeed(health === undefined || health === "healthy")
    }),
    Effect.repeat({
      until: (healthy) => healthy,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(new Error("The Relay didn't become healthy in time")),
    })
  )
}
