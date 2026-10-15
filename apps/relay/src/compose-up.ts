/**
 * `docker compose up --detach --build --remove-orphans` over the Engine API,
 * for a project read by `./compose-project.js`.
 *
 * Networks, volumes, and containers carry the `com.docker.compose.*` labels
 * Compose gives them, and are sent with the bodies Compose sends, so
 * projects Compose deployed are found, replaced, and removed as before. Each
 * service has one container. Containers are created in dependency order,
 * replacing the service's previous container (keeping its anonymous
 * volumes), and started once what they depend on is started, healthy, or
 * has completed, as `depends_on` asks.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { Deferred, Effect } from "effect"

import type {
  ComposeNetwork,
  ComposeProject,
  ComposeService,
} from "./compose-project.js"
import { dependencyOrder } from "./compose-project.js"
import { buildImage } from "./docker-build.js"
import {
  type DockerContainerSummary,
  type DockerEngine,
  isDockerNotFound,
} from "./docker-engine.js"

const PROJECT_LABEL = "com.docker.compose.project"
const SERVICE_LABEL = "com.docker.compose.service"
const ONEOFF_LABEL = "com.docker.compose.oneoff"
const NETWORK_LABEL = "com.docker.compose.network"
const VOLUME_LABEL = "com.docker.compose.volume"
const CONFIG_HASH_LABEL = "com.docker.compose.config-hash"
// Compose's default grace period before it kills a stopping container.
const DEFAULT_STOP_SECONDS = 10

export interface ComposeUpOptions {
  readonly project: ComposeProject
  /** The project directory, as Relay sees it, for Compose's labels. */
  readonly workingDirectory: string
  readonly onLine: (line: string) => void
  /** For each build. */
  readonly buildTimeout?: number
}

interface InspectedContainer {
  readonly Id: string
  readonly Name: string
  readonly Mounts?: ReadonlyArray<{
    readonly Destination: string
    readonly Name?: string
    readonly Type: string
  }>
  readonly State: {
    readonly ExitCode: number
    readonly Health?: { readonly Status: string }
    readonly Running: boolean
    readonly Status: string
  }
}

export function composeUp(
  engine: DockerEngine,
  options: ComposeUpOptions
): Effect.Effect<void, Error> {
  const { project, onLine } = options
  const services = project.services
  return Effect.gen(function* () {
    const order = dependencyOrder(services)
    const images = new Map<string, string>()
    for (const name of order) {
      images.set(name, yield* ensureImage(engine, project, name, options))
    }
    const networks = yield* ensureNetworks(engine, project, onLine)
    const volumes = yield* ensureVolumes(engine, project, onLine)

    const existing = yield* engine.listContainers({
      all: true,
      filters: { label: [`${PROJECT_LABEL}=${project.name}`] },
    })
    const current = existing.filter(
      (container) => container.Labels?.[ONEOFF_LABEL] !== "True"
    )
    // Services no longer in the project (orphans) go, and every service's
    // previous container stops, all at once, each with its own grace period,
    // as Compose handles independent services in parallel.
    const orphans = current.filter(
      (container) => !services[container.Labels?.[SERVICE_LABEL] ?? ""]
    )
    const replaced = current.filter(
      (container) => services[container.Labels?.[SERVICE_LABEL] ?? ""]
    )
    yield* Effect.forEach(
      [...orphans, ...replaced],
      (container) => {
        const orphan = orphans.includes(container)
        const seconds = orphan
          ? DEFAULT_STOP_SECONDS
          : (services[container.Labels?.[SERVICE_LABEL] ?? ""]?.stop_grace_period ??
            DEFAULT_STOP_SECONDS)
        const name = containerNameOf(container)
        onLine(`Container ${name}  ${orphan ? "Removing" : "Recreate"}`)
        return engine
          .stopContainer(container.Id, { seconds, timeout: (seconds + 30) * 1_000 })
          .pipe(
            Effect.andThen(
              orphan
                ? engine
                    .removeContainer(container.Id, { force: true, timeout: 90_000 })
                    .pipe(Effect.tap(() => Effect.sync(() => onLine(`Container ${name}  Removed`))))
                : Effect.void
            )
          )
      },
      { concurrency: "unbounded", discard: true }
    )

    const created = new Map<string, Deferred.Deferred<string, Error>>()
    const started = new Map<string, Deferred.Deferred<void, Error>>()
    for (const name of order) {
      created.set(name, yield* Deferred.make<string, Error>())
      started.set(name, yield* Deferred.make<void, Error>())
    }
    const createdId = (name: string) => Deferred.await(created.get(name)!)

    const create = (name: string) =>
      Effect.gen(function* () {
        const service = services[name]!
        const containerName = service.container_name ?? `${project.name}-${name}-1`
        // Containers this one shares a network or volumes with exist first.
        const linked = new Map<string, string>()
        for (const dependency of linkedServices(service)) {
          if (created.has(dependency)) {
            linked.set(dependency, yield* createdId(dependency))
          }
        }
        const previous = replaced.filter(
          (container) => container.Labels?.[SERVICE_LABEL] === name
        )
        const inherited: Array<{ Source: string; Target: string; Type: "volume" }> = []
        for (const container of previous) {
          const inspected = yield* engine.inspectContainer<InspectedContainer>(
            container.Id
          )
          inherited.push(...anonymousVolumes(inspected, service))
        }
        if (previous.length === 0) onLine(`Container ${containerName}  Creating`)
        const image = images.get(name)!
        const imageId = (yield* engine.inspectImage(image)).Id
        const body = containerBody(project, name, service, {
          containerName,
          image,
          imageId,
          inherited,
          networks,
          replacing: previous.length > 0,
          volumes,
          workingDirectory: options.workingDirectory,
          containerOf: (dependency) => linked.get(dependency),
        })
        const container = yield* engine.createContainer(containerName, body, {
          platform: service.platform,
        })
        for (const old of previous) {
          yield* engine.removeContainer(old.Id, { force: true, timeout: 90_000 })
        }
        onLine(
          `Container ${containerName}  ${previous.length > 0 ? "Recreated" : "Created"}`
        )
        return container.Id
      })

    const start = (name: string) =>
      Effect.gen(function* () {
        const service = services[name]!
        for (const dependency of linkedServices(service)) {
          const dependencyStarted = started.get(dependency)
          if (dependencyStarted) yield* Deferred.await(dependencyStarted)
        }
        for (const [dependency, settings] of Object.entries(
          service.depends_on ?? {}
        )) {
          const dependencyStarted = started.get(dependency)
          if (!dependencyStarted) continue
          yield* Deferred.await(dependencyStarted)
          yield* waitForDependency(
            engine,
            yield* createdId(dependency),
            dependency,
            settings.condition,
            onLine
          )
        }
        const containerName = service.container_name ?? `${project.name}-${name}-1`
        onLine(`Container ${containerName}  Starting`)
        yield* engine.startContainer(yield* createdId(name), { timeout: 120_000 })
        onLine(`Container ${containerName}  Started`)
      })

    yield* Effect.forEach(
      order,
      (name) =>
        create(name).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Deferred.done(created.get(name)!, exit).pipe(
              Effect.andThen(exit)
            )
          )
        ),
      { concurrency: "unbounded", discard: true }
    )
    yield* Effect.forEach(
      order,
      (name) =>
        start(name).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Deferred.done(started.get(name)!, exit).pipe(
              Effect.andThen(exit)
            )
          )
        ),
      { concurrency: "unbounded", discard: true }
    )
  })
}

// ---------------------------------------------------------------- images

function ensureImage(
  engine: DockerEngine,
  project: ComposeProject,
  name: string,
  options: ComposeUpOptions
): Effect.Effect<string, Error> {
  const service = project.services[name]!
  const image = service.image ?? `${project.name}-${name}`
  return Effect.gen(function* () {
    if (service.build && service.pull_policy !== "never") {
      options.onLine(`Image ${image}  Building`)
      const dockerfile = yield* dockerfileFor(service.build)
      yield* buildImage(engine, {
        buildArgs: service.build.args,
        context: service.build.context,
        dockerfile,
        labels: {
          ...service.build.labels,
          [PROJECT_LABEL]: project.name,
          [SERVICE_LABEL]: name,
        },
        noCache: service.build.no_cache,
        onLine: options.onLine,
        pull: service.build.pull,
        tag: image,
        target: service.build.target,
        timeout: options.buildTimeout,
      })
      options.onLine(`Image ${image}  Built`)
      return image
    }
    const local = yield* engine.inspectImage(image).pipe(
      Effect.map(() => true),
      Effect.catchIf(isDockerNotFound, () => Effect.succeed(false))
    )
    if (service.pull_policy === "never" || service.pull_policy === "build") {
      if (!local) {
        return yield* Effect.fail(
          new Error(`No such image: ${image} (pull_policy ${service.pull_policy})`)
        )
      }
      return image
    }
    if (local && service.pull_policy !== "always") return image
    options.onLine(`Image ${image}  Pulling`)
    yield* engine.pullImage(image, { onLine: options.onLine, timeout: 15 * 60_000 })
    options.onLine(`Image ${image}  Pulled`)
    return image
  })
}

// A Dockerfile in the context is read from it; one elsewhere is sent along.
function dockerfileFor(build: NonNullable<ComposeService["build"]>) {
  if (build.dockerfile_inline !== undefined) {
    return Effect.succeed({ content: build.dockerfile_inline })
  }
  const path = resolve(build.context, build.dockerfile ?? "Dockerfile")
  const inside = relative(build.context, path)
  if (!inside.startsWith("..") && !inside.startsWith("/")) {
    return Effect.succeed({ path: inside })
  }
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new Error(`The Dockerfile ${build.dockerfile} could not be read`),
  }).pipe(Effect.map((content) => ({ content })))
}

// ------------------------------------------------------ networks, volumes

/** Each network services join, by key, as Docker names it. */
function ensureNetworks(
  engine: DockerEngine,
  project: ComposeProject,
  onLine: (line: string) => void
): Effect.Effect<Map<string, string>, Error> {
  return Effect.gen(function* () {
    const used = new Set(
      Object.values(project.services).flatMap((service) =>
        Object.keys(service.networks ?? {})
      )
    )
    const names = new Map<string, string>()
    for (const key of [...used].sort()) {
      const network = (project.networks?.[key] ?? {}) as ComposeNetwork
      const name = network.name ?? `${project.name}_${key}`
      names.set(key, name)
      const found = yield* engine.inspectNetwork(name).pipe(
        Effect.map((inspected) => inspected as { Labels: Record<string, string> | null } | null),
        Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))
      )
      if (network.external) {
        if (!found) {
          return yield* Effect.fail(
            new Error(`network ${name} declared as external, but could not be found`)
          )
        }
        continue
      }
      if (found) {
        const labels = found.Labels ?? {}
        if ((labels[NETWORK_LABEL] ?? "") !== key) {
          return yield* Effect.fail(
            new Error(
              `network ${name} was found but has incorrect label ${NETWORK_LABEL} set to "${labels[NETWORK_LABEL] ?? ""}" (expected: "${key}")`
            )
          )
        }
        if (labels[PROJECT_LABEL] !== project.name) {
          onLine(
            `a network with name ${name} exists but was not created for project "${project.name}". Set \`external: true\` to use an existing network`
          )
        }
        continue
      }
      onLine(`Network ${name}  Creating`)
      const ipam = network.ipam
      yield* engine
        .createNetworkFrom({
          Attachable: network.attachable ?? false,
          ConfigFrom: null,
          ConfigOnly: false,
          Driver: network.driver ?? "",
          ...(network.enable_ipv6 !== undefined && {
            EnableIPv6: network.enable_ipv6,
          }),
          IPAM: ipam
            ? {
                Config: (ipam.config ?? []).map((config) => ({
                  ...(config.subnet && { Subnet: config.subnet }),
                  ...(config.ip_range && { IPRange: config.ip_range }),
                  ...(config.gateway && { Gateway: config.gateway }),
                  ...(config.aux_addresses && {
                    AuxiliaryAddresses: config.aux_addresses,
                  }),
                })),
                Driver: ipam.driver ?? "",
                Options: ipam.options ?? null,
              }
            : null,
          Ingress: false,
          Internal: network.internal ?? false,
          Labels: {
            ...network.labels,
            [CONFIG_HASH_LABEL]: hash(network),
            [NETWORK_LABEL]: key,
            [PROJECT_LABEL]: project.name,
          },
          Name: name,
          Options: network.driver_opts ?? null,
          Scope: "",
        })
        .pipe(
          // Created meanwhile, such as by a parallel deploy.
          Effect.catchIf(
            (cause) => cause.status === 409,
            () => Effect.void
          )
        )
      onLine(`Network ${name}  Created`)
    }
    return names
  })
}

/** Each named volume services mount, by key, as Docker names it. */
function ensureVolumes(
  engine: DockerEngine,
  project: ComposeProject,
  onLine: (line: string) => void
): Effect.Effect<Map<string, string>, Error> {
  return Effect.gen(function* () {
    const used = new Set(
      Object.values(project.services).flatMap((service) =>
        (service.volumes ?? []).flatMap((volume) =>
          volume.type === "volume" && volume.source ? [volume.source] : []
        )
      )
    )
    const names = new Map<string, string>()
    for (const key of [...used].sort()) {
      const volume = project.volumes?.[key] ?? {}
      const name = volume.name ?? `${project.name}_${key}`
      names.set(key, name)
      const found = yield* engine.inspectVolume(name).pipe(
        Effect.map((inspected) => inspected as { Labels: Record<string, string> | null } | null),
        Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))
      )
      if (volume.external) {
        if (!found) {
          return yield* Effect.fail(
            new Error(`external volume "${name}" not found`)
          )
        }
        continue
      }
      if (found) {
        const labels = found.Labels ?? {}
        if (labels[PROJECT_LABEL] !== project.name || labels[VOLUME_LABEL] !== key) {
          onLine(
            `volume "${name}" already exists but was not created by Docker Compose. Use \`external: true\` to use an existing volume`
          )
        }
        continue
      }
      onLine(`Volume ${name}  Creating`)
      yield* engine.createVolumeFrom({
        ...(volume.driver && { Driver: volume.driver }),
        ...(volume.driver_opts && { DriverOpts: volume.driver_opts }),
        Labels: {
          ...volume.labels,
          [CONFIG_HASH_LABEL]: hash(volume),
          [PROJECT_LABEL]: project.name,
          [VOLUME_LABEL]: key,
        },
        Name: name,
      })
      onLine(`Volume ${name}  Created`)
    }
    return names
  })
}

// ------------------------------------------------------------ containers

/** The body `docker compose up` sends to create a service's container. */
function containerBody(
  project: ComposeProject,
  name: string,
  service: ComposeService,
  context: {
    readonly containerName: string
    readonly image: string
    readonly imageId: string
    readonly inherited: ReadonlyArray<{ Source: string; Target: string; Type: "volume" }>
    readonly networks: ReadonlyMap<string, string>
    /** Whether the container replaces the service's previous one. */
    readonly replacing: boolean
    readonly volumes: ReadonlyMap<string, string>
    readonly workingDirectory: string
    readonly containerOf: (service: string) => string | undefined
  }
): unknown {
  const exposed: Record<string, object> = {}
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {}
  for (const port of service.ports ?? []) {
    const key = `${port.target}/${port.protocol}`
    exposed[key] = {}
    bindings[key] = [
      ...(bindings[key] ?? []),
      { HostIp: port.host_ip ?? "", HostPort: port.published ?? "" },
    ]
  }
  for (const port of service.expose ?? []) {
    exposed[port.includes("/") ? port : `${port}/tcp`] = {}
  }

  const binds: Array<string> = []
  const mounts: Array<Record<string, unknown>> = []
  for (const volume of service.volumes ?? []) {
    if (volume.type === "tmpfs") {
      mounts.push({
        Target: volume.target,
        ...(volume.tmpfs && {
          TmpfsOptions: {
            ...(volume.tmpfs.size !== undefined && { SizeBytes: volume.tmpfs.size }),
            ...(volume.tmpfs.mode !== undefined && { Mode: volume.tmpfs.mode }),
          },
        }),
        Type: "tmpfs",
      })
      continue
    }
    if (volume.type === "volume" && !volume.source) {
      mounts.push({ Target: volume.target, Type: "volume" })
      continue
    }
    const source =
      volume.type === "volume"
        ? (context.volumes.get(volume.source!) ?? volume.source!)
        : volume.source!
    if (volume.volume?.nocopy || volume.volume?.subpath) {
      mounts.push({
        ReadOnly: volume.read_only ?? false,
        Source: source,
        Target: volume.target,
        Type: "volume",
        VolumeOptions: {
          ...(volume.volume.nocopy && { NoCopy: true }),
          ...(volume.volume.subpath && { Subpath: volume.volume.subpath }),
        },
      })
      continue
    }
    const mode = [
      volume.read_only ? "ro" : "rw",
      ...(volume.bind?.selinux ? [volume.bind.selinux] : []),
      ...(volume.bind?.propagation ? [volume.bind.propagation] : []),
    ].join(",")
    binds.push(`${source}:${volume.target}:${mode}`)
  }
  mounts.push(...context.inherited)

  const [networkMode, endpoints] = networking(service, name, context)
  const restart = /^on-failure(?::(\d+))?$/u.exec(service.restart ?? "")
  const env = Object.entries(service.environment ?? {}).map(
    ([key, value]) => `${key}=${value}`
  )
  const health = service.healthcheck
  const labels = {
    ...service.labels,
    [CONFIG_HASH_LABEL]: hash(service),
    "com.docker.compose.container-number": "1",
    "com.docker.compose.depends_on": Object.entries(service.depends_on ?? {})
      .map(([dependency, settings]) => `${dependency}:${settings.condition}:${settings.restart}`)
      .sort()
      .join(","),
    "com.docker.compose.image": context.imageId,
    [ONEOFF_LABEL]: "False",
    [PROJECT_LABEL]: project.name,
    "com.docker.compose.project.config_files": "-",
    "com.docker.compose.project.working_dir": context.workingDirectory,
    [SERVICE_LABEL]: name,
    ...(context.replacing && {
      "com.docker.compose.replace": context.containerName,
    }),
  }
  return {
    AttachStderr: true,
    AttachStdin: false,
    AttachStdout: true,
    Cmd: service.command ?? null,
    Domainname: service.domainname ?? "",
    Entrypoint: service.entrypoint ?? null,
    Env: env.length > 0 ? env : null,
    ...(Object.keys(exposed).length > 0 && { ExposedPorts: exposed }),
    ...(health && {
      Healthcheck: {
        Test: health.test.length > 0 ? health.test : null,
        ...(health.interval !== undefined && { Interval: health.interval }),
        ...(health.timeout !== undefined && { Timeout: health.timeout }),
        ...(health.start_period !== undefined && { StartPeriod: health.start_period }),
        ...(health.start_interval !== undefined && { StartInterval: health.start_interval }),
        ...(health.retries !== undefined && { Retries: health.retries }),
      },
    }),
    Hostname: service.hostname ?? "",
    Image: context.image,
    Labels: labels,
    ...(service.mac_address && { MacAddress: service.mac_address }),
    OpenStdin: service.stdin_open ?? false,
    StdinOnce: false,
    ...(service.stop_signal && { StopSignal: service.stop_signal }),
    ...(service.stop_grace_period !== undefined && {
      StopTimeout: service.stop_grace_period,
    }),
    Tty: service.tty ?? false,
    User: service.user ?? "",
    Volumes: null,
    WorkingDir: service.working_dir ?? "",
    HostConfig: {
      AutoRemove: false,
      Binds: binds.length > 0 ? binds : null,
      BlkioDeviceReadBps: null,
      BlkioDeviceReadIOps: null,
      BlkioDeviceWriteBps: null,
      BlkioDeviceWriteIOps: null,
      BlkioWeight: 0,
      BlkioWeightDevice: null,
      CapAdd: service.cap_add ?? null,
      CapDrop: service.cap_drop ?? null,
      Cgroup: service.cgroup ?? "",
      CgroupParent: service.cgroup_parent ?? "",
      CgroupnsMode: "",
      ConsoleSize: [0, 0],
      ContainerIDFile: "",
      CpuCount: 0,
      CpuPercent: 0,
      CpuPeriod: service.cpu_period ?? 0,
      CpuQuota: service.cpu_quota ?? 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpuShares: service.cpu_shares ?? 0,
      CpusetCpus: service.cpuset ?? "",
      CpusetMems: "",
      DeviceCgroupRules: null,
      DeviceRequests: null,
      Devices: service.devices?.length
        ? service.devices.map((entry) => ({
            CgroupPermissions: entry.permissions,
            PathInContainer: entry.target,
            PathOnHost: entry.source,
          }))
        : null,
      Dns: service.dns ?? null,
      DnsOptions: service.dns_opt ?? null,
      DnsSearch: service.dns_search ?? null,
      ExtraHosts: service.extra_hosts ?? [],
      GroupAdd: service.group_add ?? null,
      IOMaximumBandwidth: 0,
      IOMaximumIOps: 0,
      ...(service.init !== undefined && { Init: service.init }),
      IpcMode: service.ipc ?? "",
      Isolation: "",
      Links: null,
      LogConfig: {
        Config: service.logging?.options ?? null,
        Type: service.logging?.driver ?? "",
      },
      MaskedPaths: null,
      Memory: service.mem_limit ?? 0,
      MemoryReservation: service.mem_reservation ?? 0,
      MemorySwap: service.memswap_limit ?? 0,
      MemorySwappiness: service.mem_swappiness ?? null,
      ...(mounts.length > 0 && { Mounts: mounts }),
      NanoCpus: service.cpus ?? 0,
      NetworkMode: networkMode,
      OomKillDisable: service.oom_kill_disable ?? false,
      OomScoreAdj: service.oom_score_adj ?? 0,
      PidMode: service.pid ?? "",
      PidsLimit: service.pids_limit ?? null,
      PortBindings: bindings,
      Privileged: service.privileged ?? false,
      PublishAllPorts: false,
      ReadonlyPaths: null,
      ReadonlyRootfs: service.read_only ?? false,
      RestartPolicy: restart
        ? { MaximumRetryCount: Number(restart[1] ?? 0), Name: "on-failure" }
        : { MaximumRetryCount: 0, Name: service.restart ?? "" },
      ...(service.runtime && { Runtime: service.runtime }),
      SecurityOpt: service.security_opt ?? null,
      ShmSize: service.shm_size ?? 0,
      ...(service.sysctls && { Sysctls: service.sysctls }),
      ...(service.tmpfs?.length && {
        Tmpfs: Object.fromEntries(
          service.tmpfs.map((entry) => {
            const separator = entry.indexOf(":")
            return separator === -1
              ? [entry, ""]
              : [entry.slice(0, separator), entry.slice(separator + 1)]
          })
        ),
      }),
      UTSMode: "",
      Ulimits: service.ulimits
        ? Object.entries(service.ulimits).map(([limit, value]) => ({
            Hard: value.hard,
            Name: limit,
            Soft: value.soft,
          }))
        : null,
      UsernsMode: service.userns_mode ?? "",
      VolumeDriver: "",
      VolumesFrom: service.volumes_from?.length
        ? service.volumes_from.map((entry) => {
            const [, kind, target = "", mode] =
              /^(?:(service|container):)?([^:]+)(?::(ro|rw))?$/u.exec(entry) ?? []
            const resolved =
              kind === "container" ? target : (context.containerOf(target) ?? target)
            return mode ? `${resolved}:${mode}` : resolved
          })
        : null,
    },
    NetworkingConfig: { EndpointsConfig: endpoints },
  }
}

// The primary network mode and each network's endpoint, primary first, by
// priority and then name, as Compose orders them.
function networking(
  service: ComposeService,
  name: string,
  context: {
    readonly containerName: string
    readonly networks: ReadonlyMap<string, string>
    readonly containerOf: (service: string) => string | undefined
  }
): [string, Record<string, unknown>] {
  if (service.network_mode) {
    const linked = /^service:(.+)$/u.exec(service.network_mode)?.[1]
    return [
      linked ? `container:${context.containerOf(linked) ?? linked}` : service.network_mode,
      {},
    ]
  }
  const keys = Object.entries(service.networks ?? {})
    .map(([key, settings]) => ({ key, priority: settings?.priority ?? 0, settings }))
    .sort((left, right) =>
      left.priority === right.priority
        ? left.key < right.key
          ? -1
          : 1
        : right.priority - left.priority
    )
  const endpoints: Record<string, unknown> = {}
  for (const { key, settings } of keys) {
    const network = context.networks.get(key) ?? key
    endpoints[network] = {
      Aliases: [context.containerName, name, ...(settings?.aliases ?? [])],
      DriverOpts: settings?.driver_opts ?? null,
      // Compose sends addresses for networks the service configures.
      IPAMConfig: settings
        ? {
            ...(settings.ipv4_address && { IPv4Address: settings.ipv4_address }),
            ...(settings.ipv6_address && { IPv6Address: settings.ipv6_address }),
          }
        : null,
      Links: null,
      ...(settings?.mac_address && { MacAddress: settings.mac_address }),
    }
  }
  const primary = keys[0]
  return [
    primary ? (context.networks.get(primary.key) ?? primary.key) : "default",
    endpoints,
  ]
}

// The previous container's anonymous volumes (image `VOLUME`s and volumes
// without a source), which Compose carries over so their data stays.
function anonymousVolumes(
  previous: InspectedContainer,
  service: ComposeService
): Array<{ Source: string; Target: string; Type: "volume" }> {
  const declared = new Set(
    (service.volumes ?? [])
      .filter((volume) => volume.source)
      .map((volume) => volume.target)
  )
  return (previous.Mounts ?? []).flatMap((mount) =>
    mount.Type === "volume" &&
    mount.Name &&
    /^[a-f0-9]{64}$/u.test(mount.Name) &&
    !declared.has(mount.Destination)
      ? [{ Source: mount.Name, Target: mount.Destination, Type: "volume" as const }]
      : []
  )
}

// --------------------------------------------------------------- startup

function waitForDependency(
  engine: DockerEngine,
  id: string,
  service: string,
  condition: NonNullable<ComposeService["depends_on"]>[string]["condition"],
  onLine: (line: string) => void
): Effect.Effect<void, Error> {
  if (condition === "service_started") return Effect.void
  return Effect.gen(function* () {
    let announced = false
    for (;;) {
      const container = yield* engine.inspectContainer<InspectedContainer>(id)
      const name = container.Name.replace(/^\//u, "")
      if (!announced) {
        onLine(`Container ${name}  Waiting`)
        announced = true
      }
      const { State: state } = container
      if (condition === "service_completed_successfully") {
        if (!state.Running && state.Status !== "created") {
          if (state.ExitCode !== 0) {
            return yield* Effect.fail(
              new Error(
                `service "${service}" didn't complete successfully: exit ${state.ExitCode}`
              )
            )
          }
          onLine(`Container ${name}  Exited`)
          return
        }
      } else {
        if (!state.Health) {
          return yield* Effect.fail(
            new Error(`container ${name} has no healthcheck configured`)
          )
        }
        if (state.Health.Status === "healthy") {
          onLine(`Container ${name}  Healthy`)
          return
        }
        if (state.Health.Status === "unhealthy") {
          return yield* Effect.fail(
            new Error(`dependency failed to start: container ${name} is unhealthy`)
          )
        }
        if (!state.Running) {
          return yield* Effect.fail(
            new Error(
              `dependency failed to start: container ${name} exited (${state.ExitCode})`
            )
          )
        }
      }
      yield* Effect.sleep(500)
    }
  })
}

// ---------------------------------------------------------------- helpers

// Services whose containers this one's shares a network namespace or
// volumes with, which must exist (and run) first.
function linkedServices(service: ComposeService): Array<string> {
  const network = /^service:(.+)$/u.exec(service.network_mode ?? "")?.[1]
  return [
    ...(network ? [network] : []),
    ...(service.volumes_from ?? []).flatMap((entry) => {
      const match = /^(service:)?([^:]+)/u.exec(entry)
      return match && !entry.startsWith("container:") ? [match[2]!] : []
    }),
  ]
}

function containerNameOf(container: DockerContainerSummary): string {
  return (container.Names[0] ?? container.Id).replace(/^\//u, "")
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
