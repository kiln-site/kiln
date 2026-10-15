/**
 * `docker compose up --detach --build --remove-orphans` over the Engine API,
 * for a project read by `./compose-project.js`, as Compose v5 runs it.
 *
 * Networks, volumes, and containers carry the `com.docker.compose.*` labels
 * Compose gives them (networks and volumes with its config hash), and are
 * sent with the bodies Compose sends, so projects Compose deployed are
 * found, replaced, and removed as before. Each service has one container,
 * replaced on every deploy: its replacement is created first under a
 * temporary name, inheriting its anonymous volumes, the old one removed,
 * and the new one renamed. Containers start once what they depend on is
 * started, healthy, or has completed, as `depends_on` asks.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { Deferred, Effect } from "effect"
import { pack as createTarPack } from "tar-stream"

import type {
  ComposeFileReference,
  ComposeNetwork,
  ComposeProject,
  ComposeService,
  ComposeVolume,
  ComposeVolumeMount,
} from "./compose-project.js"
import { dependencyOrder } from "./compose-project.js"
import { buildImage } from "./docker-build.js"
import { withProxyEnvironment } from "./docker-client-config.js"
import {
  defaultPlatform,
  type DockerEngine,
  isDockerNotFound,
} from "./docker-engine.js"

const PROJECT_LABEL = "com.docker.compose.project"
const SERVICE_LABEL = "com.docker.compose.service"
const ONEOFF_LABEL = "com.docker.compose.oneoff"
const NETWORK_LABEL = "com.docker.compose.network"
const VOLUME_LABEL = "com.docker.compose.volume"
const CONFIG_HASH_LABEL = "com.docker.compose.config-hash"
// How long a stop may take past Docker's grace period before it's an error.
const STOP_MARGIN_MS = 60_000

export interface ComposeUpOptions {
  readonly project: ComposeProject
  /** The project directory, as Relay sees it, for Compose's labels. */
  readonly workingDirectory: string
  readonly onLine: (line: string) => void
  /** For each build. */
  readonly buildTimeout?: number
}

interface ContainerSummary {
  readonly Id: string
  readonly Labels: Readonly<Record<string, string>> | null
  readonly Mounts?: ReadonlyArray<{
    readonly Destination: string
    readonly Name?: string
    readonly RW?: boolean
    readonly Source?: string
    readonly Type: string
  }>
  readonly Names: ReadonlyArray<string>
}

interface InspectedContainer {
  readonly Config?: {
    readonly Healthcheck?: { readonly Test?: ReadonlyArray<string> } | null
  }
  readonly Id: string
  readonly Name: string
  readonly State: {
    readonly ExitCode: number
    readonly Health?: { readonly Status: string }
    readonly Running: boolean
    readonly Status: string
  }
}

interface InspectedImage {
  readonly Architecture?: string
  readonly Config?: {
    readonly Volumes?: Readonly<Record<string, unknown>> | null
  }
  readonly Id: string
  readonly Os?: string
  readonly Variant?: string
}

export function composeUp(
  engine: DockerEngine,
  options: ComposeUpOptions
): Effect.Effect<void, Error> {
  const { onLine } = options
  // Optional dependencies on services that aren't enabled are dropped, as
  // Compose drops them before running anything.
  const project = withoutUnresolvedOptionalDependencies(options.project)
  const services = project.services
  const platformOf = (service: ComposeService) =>
    service.platform ||
    project.environment?.DOCKER_DEFAULT_PLATFORM ||
    defaultPlatform()
  return Effect.gen(function* () {
    const order = dependencyOrder(services)
    const images = new Map<string, InspectedImage & { readonly name: string }>()
    for (const name of order) {
      images.set(
        name,
        yield* ensureImage(
          engine,
          project,
          name,
          platformOf(services[name]!),
          options
        )
      )
    }
    const existing = (yield* engine.listContainers({
      all: true,
      filters: { label: [`${PROJECT_LABEL}=${project.name}`] },
    })) as unknown as ReadonlyArray<ContainerSummary>
    const current = existing.filter(
      (container) => container.Labels?.[ONEOFF_LABEL] !== "True"
    )
    const networks = yield* ensureNetworks(engine, project, current, onLine)
    const volumes = yield* ensureVolumes(engine, project, onLine)

    // Services no longer in the project (orphans) go, and every service's
    // previous container stops, all at once, as Compose handles
    // independent services in parallel. Docker gives each its own grace
    // period.
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
        const name = containerNameOf(container)
        onLine(`Container ${name}  ${orphan ? "Removing" : "Recreate"}`)
        return engine
          .stopContainer(container.Id, { timeout: STOP_MARGIN_MS + 600_000 })
          .pipe(
            Effect.andThen(
              orphan
                ? engine
                    .removeContainer(container.Id, {
                      force: true,
                      timeout: 90_000,
                    })
                    .pipe(
                      Effect.tap(() =>
                        Effect.sync(() => onLine(`Container ${name}  Removed`))
                      )
                    )
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
        const containerName =
          service.container_name ?? `${project.name}-${name}-1`
        // Containers this one shares a namespace or volumes with exist first.
        const linked = new Map<string, string>()
        for (const dependency of linkedServices(service)) {
          if (created.has(dependency)) {
            linked.set(dependency, yield* createdId(dependency))
          }
        }
        const previous = replaced.find(
          (container) => container.Labels?.[SERVICE_LABEL] === name
        )
        const others = replaced.filter(
          (container) =>
            container.Labels?.[SERVICE_LABEL] === name && container !== previous
        )
        if (!previous) onLine(`Container ${containerName}  Creating`)
        const image = images.get(name)!
        const body = yield* containerBody(project, name, service, {
          containerName,
          containerOf: (dependency) => linked.get(dependency),
          image,
          inherit: previous,
          networks,
          replacing: previous !== undefined,
          volumes,
          workingDirectory: options.workingDirectory,
        })
        // A replacement is created beside the container it replaces, then
        // takes its name, as Compose does.
        const temporary = previous
          ? `${previous.Id.slice(0, 12)}_${containerName}`
          : containerName
        const container = yield* engine.createContainer(temporary, body, {
          platform: platformOf(service),
        })
        for (const old of [...(previous ? [previous] : []), ...others]) {
          yield* engine.removeContainer(old.Id, {
            force: true,
            timeout: 90_000,
          })
        }
        if (previous) yield* engine.renameContainer(container.Id, containerName)
        onLine(
          `Container ${containerName}  ${previous ? "Recreated" : "Created"}`
        )
        return container.Id
      })

    const start = (name: string) =>
      Effect.gen(function* () {
        const service = services[name]!
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
            settings,
            onLine
          )
        }
        const id = yield* createdId(name)
        yield* injectFiles(engine, project, name, service, id)
        const containerName =
          service.container_name ?? `${project.name}-${name}-1`
        onLine(`Container ${containerName}  Starting`)
        yield* engine.startContainer(id, { timeout: 120_000 })
        onLine(`Container ${containerName}  Started`)
      })

    yield* Effect.forEach(
      order,
      (name) =>
        create(name).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Deferred.done(created.get(name)!, exit).pipe(Effect.andThen(exit))
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
            Deferred.done(started.get(name)!, exit).pipe(Effect.andThen(exit))
          )
        ),
      { concurrency: "unbounded", discard: true }
    )
  })
}

function withoutUnresolvedOptionalDependencies(
  project: ComposeProject
): ComposeProject {
  const services = Object.fromEntries(
    Object.entries(project.services).map(([name, service]) => {
      if (!service.depends_on) return [name, service]
      const dependsOn = Object.fromEntries(
        Object.entries(service.depends_on).filter(
          ([dependency, settings]) =>
            settings.required || project.services[dependency] !== undefined
        )
      )
      return [
        name,
        {
          ...service,
          ...(Object.keys(dependsOn).length > 0
            ? { depends_on: dependsOn }
            : { depends_on: undefined }),
        },
      ]
    })
  )
  return { ...project, services }
}

// ---------------------------------------------------------------- images

// Builds the image of a service with a build section (as `up --build`
// does), or pulls its image when the pull policy asks: always, or when
// missing (including when the local image is for another platform).
function ensureImage(
  engine: DockerEngine,
  project: ComposeProject,
  name: string,
  platform: string | undefined,
  options: ComposeUpOptions
): Effect.Effect<InspectedImage & { readonly name: string }, Error> {
  const service = project.services[name]!
  const image = service.image ?? `${project.name}-${name}`
  const inspect = engine.inspectImage<InspectedImage>(image)
  return Effect.gen(function* () {
    if (service.build) {
      options.onLine(`Image ${image}  Building`)
      yield* buildImage(engine, {
        buildArgs: service.build.args,
        context: service.build.context,
        dockerfile:
          service.build.dockerfile_inline !== undefined
            ? { content: service.build.dockerfile_inline }
            : { path: service.build.dockerfile ?? "Dockerfile" },
        labels: {
          ...service.build.labels,
          [PROJECT_LABEL]: project.name,
          [SERVICE_LABEL]: name,
        },
        noCache: service.build.no_cache,
        onLine: options.onLine,
        platform,
        pull: service.build.pull,
        tag: image,
        target: service.build.target,
        timeout: options.buildTimeout,
      })
      options.onLine(`Image ${image}  Built`)
      return { ...(yield* inspect), name: image }
    }
    const local = yield* inspect.pipe(
      Effect.map((found): InspectedImage | undefined => found),
      Effect.catchIf(isDockerNotFound, () => Effect.succeed(undefined))
    )
    const present =
      local !== undefined && matchesPlatform(local, service.platform)
    const policy = service.pull_policy ?? "missing"
    if (policy === "always" || (policy === "missing" && !present)) {
      options.onLine(`Image ${image}  Pulling`)
      yield* engine.pullImage(image, {
        onLine: options.onLine,
        platform,
        timeout: 15 * 60_000,
      })
      options.onLine(`Image ${image}  Pulled`)
      return { ...(yield* inspect), name: image }
    }
    if (!local) {
      return yield* Effect.fail(
        new Error(`No such image: ${image} (pull_policy ${policy})`)
      )
    }
    return { ...local, name: image }
  })
}

// Whether a local image is for the platform a service pins, as Compose
// checks before using it (an image with no platform pinned always is).
function matchesPlatform(image: InspectedImage, platform: string | undefined) {
  if (!platform) return true
  const [os = "", architecture = "", variant] = platform
    .toLowerCase()
    .split("/")
  const arch = (value: string) =>
    ({
      aarch64: "arm64",
      armhf: "arm",
      armel: "arm",
      i386: "386",
      x86_64: "amd64",
    })[value] ?? value
  const imageVariant = image.Variant ?? ""
  return (
    image.Os === os &&
    arch(image.Architecture ?? "") === arch(architecture) &&
    (variant === undefined ||
      imageVariant === variant ||
      (arch(architecture) === "arm64" &&
        [variant, imageVariant].every((v) => v === "" || v === "v8")))
  )
}

// ------------------------------------------------------ networks, volumes

/**
 * Each network services join, by key, as Docker names it: created when
 * missing, and recreated when its configuration changed (by Compose's
 * config hash), after the project's containers on it stop and leave it.
 */
function ensureNetworks(
  engine: DockerEngine,
  project: ComposeProject,
  containers: ReadonlyArray<ContainerSummary>,
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
      if (network.external) {
        const found = yield* engine.inspectNetwork(name).pipe(
          Effect.map(() => true),
          Effect.catchIf(isDockerNotFound, () => Effect.succeed(false))
        )
        if (!found) {
          return yield* Effect.fail(
            new Error(
              `network ${name} declared as external, but could not be found`
            )
          )
        }
        continue
      }
      const labelled = (yield* engine.listNetworks({
        filters: {
          label: [
            `${PROJECT_LABEL}=${project.name}`,
            `${NETWORK_LABEL}=${key}`,
          ],
        },
      })) as unknown as ReadonlyArray<{
        readonly Labels?: Record<string, string> | null
        readonly Name: string
      }>
      const observed =
        labelled.find((candidate) => candidate.Name === name) ??
        [...labelled].sort((left, right) =>
          left.Name < right.Name ? -1 : 1
        )[0] ??
        (yield* engine.inspectNetwork(name).pipe(
          Effect.map(
            (found) =>
              found as unknown as {
                readonly Labels?: Record<string, string> | null
                readonly Name: string
              }
          ),
          Effect.catchIf(isDockerNotFound, () => Effect.succeed(undefined))
        ))
      const expected = networkHash(network, name)
      if (observed) {
        const labels = observed.Labels ?? {}
        const owned = labels[PROJECT_LABEL] === project.name
        if (!owned) {
          onLine(
            labels[PROJECT_LABEL]
              ? `a network with name ${name} exists but was not created for project "${project.name}". Set \`external: true\` to use an existing network`
              : `a network with name ${name} exists but was not created by compose. Set \`external: true\` to use an existing network`
          )
        }
        const recorded = owned ? (labels[CONFIG_HASH_LABEL] ?? "") : ""
        if (recorded === "" || recorded === expected) continue
        // Changed: the project's containers on it stop and leave it, and
        // it's created again (under its new name, if renamed).
        onLine(`Network ${observed.Name}  Recreate`)
        const attached = containers.filter((container) =>
          Object.keys(
            (
              container as unknown as {
                NetworkSettings?: { Networks?: Record<string, unknown> }
              }
            ).NetworkSettings?.Networks ?? {}
          ).includes(observed.Name)
        )
        for (const container of attached) {
          yield* engine.stopContainer(container.Id, {
            timeout: STOP_MARGIN_MS + 600_000,
          })
          yield* engine
            .disconnectNetwork(observed.Name, container.Id, { force: true })
            .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
        }
        const removal = engine.removeNetwork(observed.Name)
        if (observed.Name === name) yield* removal
        else yield* removal.pipe(Effect.ignore)
      }
      onLine(`Network ${name}  Creating`)
      const ipam = network.ipam
      yield* engine
        .createNetworkFrom({
          Attachable: network.attachable ?? false,
          ConfigFrom: null,
          ConfigOnly: false,
          Driver: network.driver ?? "",
          ...(network.enable_ipv4 !== undefined && {
            EnableIPv4: network.enable_ipv4,
          }),
          ...(network.enable_ipv6 !== undefined && {
            EnableIPv6: network.enable_ipv6,
          }),
          IPAM:
            ipam && (ipam.driver || ipam.config?.length || ipam.options)
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
            [CONFIG_HASH_LABEL]: expected,
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
        Effect.map(
          (inspected) =>
            inspected as { Labels: Record<string, string> | null } | null
        ),
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
        if (
          labels[PROJECT_LABEL] !== project.name ||
          labels[VOLUME_LABEL] !== key
        ) {
          onLine(
            `volume "${name}" already exists but was not created by Docker Compose. Use \`external: true\` to use an existing volume`
          )
        }
        // A volume whose configuration changed is kept, with its data, as
        // Compose keeps it when it can't ask.
        continue
      }
      onLine(`Volume ${name}  Creating`)
      yield* engine.createVolumeFrom({
        ...(volume.driver && { Driver: volume.driver }),
        ...(volume.driver_opts && { DriverOpts: volume.driver_opts }),
        Labels: {
          ...volume.labels,
          [CONFIG_HASH_LABEL]: volumeHash(volume, name),
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
    readonly containerOf: (service: string) => string | undefined
    readonly image: InspectedImage & { readonly name: string }
    /** The container this one replaces, whose anonymous volumes it keeps. */
    readonly inherit: ContainerSummary | undefined
    readonly networks: ReadonlyMap<string, string>
    /** Whether the container replaces the service's previous one. */
    readonly replacing: boolean
    readonly volumes: ReadonlyMap<string, string>
    readonly workingDirectory: string
  }
): Effect.Effect<unknown, Error> {
  return Effect.gen(function* () {
    const exposed: Record<string, object> = {}
    const bindings: Record<
      string,
      Array<{ HostIp: string; HostPort: string }>
    > = {}
    for (const port of service.ports ?? []) {
      const key = `${port.target}/${port.protocol}`
      exposed[key] = {}
      bindings[key] = [
        ...(bindings[key] ?? []),
        { HostIp: port.host_ip ?? "", HostPort: port.published ?? "" },
      ]
    }
    for (const entry of service.expose ?? []) {
      const [ports = "", protocol = "tcp"] = entry.split("/")
      const [start = 0, end = start] = ports.split("-").map(Number)
      for (let port = start; port <= end; port += 1) {
        exposed[`${port}/${protocol.toLowerCase()}`] = {}
      }
    }

    const { binds, mounts } = containerMounts(project, service, context)
    const [networkMode, endpoints] = networking(service, name, context)
    const security = yield* securityOptions(
      context.workingDirectory,
      service.security_opt
    )
    const environment = yield* withProxyEnvironment(undefined)
    // Unset variables (null) are sent bare, which unsets them.
    const env = Object.entries({ ...environment, ...service.environment }).map(
      ([key, value]) => (value === null ? key : `${key}=${value}`)
    )
    const health = service.healthcheck
    if (
      health?.start_interval !== undefined &&
      health.start_period === undefined
    ) {
      return yield* Effect.fail(
        new Error(
          "healthcheck.start_interval requires healthcheck.start_period to be set"
        )
      )
    }
    const labels = {
      ...service.labels,
      [CONFIG_HASH_LABEL]: hash(service),
      "com.docker.compose.container-number": "1",
      "com.docker.compose.depends_on": Object.entries(service.depends_on ?? {})
        .map(
          ([dependency, settings]) =>
            `${dependency}:${settings.condition}:${settings.restart}`
        )
        .sort()
        .join(","),
      "com.docker.compose.image": context.image.Id,
      [ONEOFF_LABEL]: "False",
      [PROJECT_LABEL]: project.name,
      "com.docker.compose.project.config_files": "-",
      "com.docker.compose.project.working_dir": context.workingDirectory,
      [SERVICE_LABEL]: name,
      ...(context.replacing && {
        "com.docker.compose.replace": context.containerName,
      }),
    }
    const dns = service.dns ?? []
    for (const address of dns) {
      if (!isIpAddress(address)) {
        return yield* Effect.fail(new Error(`invalid DNS address: ${address}`))
      }
    }
    const resolveShared = (mode: string | undefined) => {
      const shared = /^service:(.+)$/u.exec(mode ?? "")?.[1]
      return shared
        ? `container:${context.containerOf(shared) ?? shared}`
        : (mode ?? "")
    }
    const policy = service.restart_policy
    const [restartName = "", restartCount = "0"] = (
      service.restart ?? ""
    ).split(":")
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
          ...(health.start_period !== undefined && {
            StartPeriod: health.start_period,
          }),
          ...(health.start_interval !== undefined && {
            StartInterval: health.start_interval,
          }),
          ...(health.retries !== undefined && { Retries: health.retries }),
        },
      }),
      Hostname: service.hostname ?? "",
      Image: context.image.name,
      Labels: labels,
      ...(service.network_mode === "disabled" && { NetworkDisabled: true }),
      OpenStdin: service.stdin_open ?? false,
      StdinOnce: false,
      ...(service.stop_signal && { StopSignal: service.stop_signal }),
      ...(service.stop_grace_period !== undefined && {
        StopTimeout: Math.trunc(service.stop_grace_period / 1e9),
      }),
      Tty: service.tty ?? false,
      User: service.user ?? "",
      Volumes: null,
      WorkingDir: service.working_dir ?? "",
      HostConfig: {
        ...(service.annotations && { Annotations: service.annotations }),
        AutoRemove: false,
        Binds: binds.length > 0 ? binds : null,
        BlkioDeviceReadBps: null,
        BlkioDeviceReadIOps: null,
        BlkioDeviceWriteBps: null,
        BlkioDeviceWriteIOps: null,
        BlkioWeight: 0,
        BlkioWeightDevice: null,
        CapAdd: service.cap_add?.map(capability) ?? null,
        CapDrop: service.cap_drop?.map(capability) ?? null,
        Cgroup: "",
        CgroupParent: service.cgroup_parent ?? "",
        CgroupnsMode: service.cgroup ?? "",
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
        DeviceCgroupRules: service.device_cgroup_rules ?? null,
        DeviceRequests: deviceRequests(service),
        Devices: (() => {
          const devices = (service.devices ?? []).filter(
            (entry) =>
              !(entry.source === entry.target && isCdiName(entry.source))
          )
          return devices.length > 0
            ? devices.map((entry) => ({
                CgroupPermissions: entry.permissions,
                PathInContainer: entry.target,
                PathOnHost: entry.source,
              }))
            : null
        })(),
        Dns: dns.length > 0 ? dns : null,
        DnsOptions: service.dns_opt ?? null,
        DnsSearch: service.dns_search ?? null,
        ExtraHosts: service.extra_hosts ?? [],
        GroupAdd: service.group_add ?? null,
        IOMaximumBandwidth: 0,
        IOMaximumIOps: 0,
        ...(service.init !== undefined && { Init: service.init }),
        IpcMode: resolveShared(service.ipc),
        Isolation: "",
        Links: null,
        LogConfig: {
          Config: service.logging?.options ?? null,
          Type: service.logging?.driver ?? "",
        },
        ...(security.unconfined && { MaskedPaths: [], ReadonlyPaths: [] }),
        Memory: service.mem_limit ?? 0,
        MemoryReservation: service.mem_reservation ?? 0,
        MemorySwap: service.memswap_limit ?? 0,
        MemorySwappiness: service.mem_swappiness
          ? service.mem_swappiness
          : null,
        ...(mounts.length > 0 && { Mounts: mounts }),
        NanoCpus: service.cpus ?? 0,
        NetworkMode: networkMode,
        OomKillDisable: service.oom_kill_disable ?? false,
        OomScoreAdj: service.oom_score_adj ?? 0,
        PidMode: resolveShared(service.pid),
        PidsLimit: service.pids_limit ? service.pids_limit : null,
        PortBindings: bindings,
        Privileged: service.privileged ?? false,
        PublishAllPorts: false,
        ReadonlyRootfs: service.read_only ?? false,
        // deploy.restart_policy takes precedence over restart.
        RestartPolicy: policy
          ? {
              MaximumRetryCount: policy.max_attempts ?? 0,
              Name: restartPolicyName(policy.condition),
            }
          : {
              MaximumRetryCount: Number(restartCount) || 0,
              Name: restartPolicyName(restartName),
            },
        ...(service.runtime && { Runtime: service.runtime }),
        SecurityOpt: security.options,
        ShmSize: service.shm_size ?? 0,
        ...(service.storage_opt && { StorageOpt: service.storage_opt }),
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
        UTSMode: service.uts ?? "",
        Ulimits: service.ulimits
          ? Object.entries(service.ulimits).map(([limit, value]) => ({
              Hard: value.hard,
              Name: limit,
              Soft: value.soft,
            }))
          : null,
        UsernsMode: service.userns_mode ?? "",
        VolumeDriver: "",
        // As Compose resolves them: the container a service has, or the
        // one named, without an access mode (Compose drops `:ro`).
        VolumesFrom: service.volumes_from?.length
          ? service.volumes_from.map((entry) => {
              const [first = "", second = ""] = entry.split(":")
              return first === "container"
                ? second
                : (context.containerOf(first) ?? first)
            })
          : null,
      },
      NetworkingConfig: endpoints ? { EndpointsConfig: endpoints } : null,
    }
  })
}

// Capabilities as Compose sends them: uppercase, with the CAP_ prefix
// (except ALL).
function capability(name: string): string {
  const upper = name.toUpperCase()
  return upper === "ALL" || upper.startsWith("CAP_") ? upper : `CAP_${upper}`
}

// Compose's restart policy names: none and no are "no", any is "always".
function restartPolicyName(condition: string): string {
  switch (condition) {
    case "none":
    case "no":
      return "no"
    case "any":
    case "always":
      return "always"
    default:
      return condition
  }
}

function deviceRequests(service: ComposeService) {
  const cdi = (service.devices ?? [])
    .filter((entry) => entry.source === entry.target && isCdiName(entry.source))
    .map((entry) => entry.source)
  const requests = [
    ...(service.device_requests ?? []).map((request) => ({
      Capabilities: [request.capabilities],
      Count: request.count,
      DeviceIDs: request.device_ids ?? null,
      Driver: request.driver ?? "",
      Options: request.options ?? null,
    })),
    ...(cdi.length > 0
      ? [
          {
            Capabilities: null,
            Count: 0,
            DeviceIDs: cdi,
            Driver: "cdi",
            Options: null,
          },
        ]
      : []),
  ]
  return requests.length > 0 ? requests : null
}

// A CDI device name, `vendor.com/class=name`.
function isCdiName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*=[a-zA-Z0-9_.:-]+$/u.test(
    name
  )
}

function isIpAddress(address: string): boolean {
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address) ||
    (/^[0-9a-f:.]+(?:%.+)?$/iu.test(address) && address.includes(":"))
  )
}

// `security_opt` as Compose passes it: `systempaths=unconfined` unmasks
// /proc and /sys, and a seccomp profile file is sent inline.
function securityOptions(
  directory: string,
  options: ReadonlyArray<string> | undefined
): Effect.Effect<
  { readonly options: Array<string> | null; readonly unconfined: boolean },
  Error
> {
  return Effect.gen(function* () {
    if (!options) return { options: null, unconfined: false }
    let unconfined = false
    const parsed: Array<string> = []
    for (const option of options) {
      if (option === "systempaths=unconfined") {
        unconfined = true
        continue
      }
      let [kind, value] = splitOnce(option, "=")
      if (value === undefined && kind !== "no-new-privileges") {
        if (!option.includes(":")) {
          return yield* Effect.fail(
            new Error(`invalid security-opt: ${JSON.stringify(option)}`)
          )
        }
        ;[kind, value] = splitOnce(option, ":")
      }
      if (kind === "seccomp" && value !== "unconfined" && value !== "builtin") {
        const path = isAbsolute(value!) ? value! : join(directory, value!)
        const profile = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (cause) =>
            new Error(
              `opening seccomp profile (${value}) failed: ${cause instanceof Error ? cause.message : String(cause)}`
            ),
        })
        const compact = yield* Effect.try({
          try: () => JSON.stringify(JSON.parse(profile)),
          catch: () =>
            new Error(`compacting json for seccomp profile (${value}) failed`),
        })
        parsed.push(`seccomp=${compact}`)
      } else {
        parsed.push(option)
      }
    }
    return { options: parsed, unconfined }
  })
}

function splitOnce(
  text: string,
  separator: string
): [string, string | undefined] {
  const index = text.indexOf(separator)
  return index === -1
    ? [text, undefined]
    : [text.slice(0, index), text.slice(index + 1)]
}

/**
 * The container's mounts as Compose builds them, by target (a later one
 * replacing an earlier): the anonymous volumes of the container it
 * replaces (the image's `VOLUME`s and the service's own anonymous volumes,
 * with their data), the service's volumes, then file secrets and configs.
 * Binds and plain volumes go in `Binds`, as the CLI sent them, and the rest
 * in `Mounts`.
 */
function containerMounts(
  project: ComposeProject,
  service: ComposeService,
  context: {
    readonly image: InspectedImage
    readonly inherit: ContainerSummary | undefined
    readonly volumes: ReadonlyMap<string, string>
  }
): {
  readonly binds: Array<string>
  readonly mounts: Array<Record<string, unknown>>
} {
  const mounts = new Map<string, Record<string, unknown>>()
  let volumes = [...(service.volumes ?? [])]
  for (const previous of context.inherit?.Mounts ?? []) {
    if (previous.Type === "tmpfs") continue
    const source =
      previous.Type === "volume"
        ? (previous.Name ?? "")
        : (previous.Source ?? "")
    const inherited = {
      ReadOnly: !previous.RW,
      Source: source,
      Target: previous.Destination,
      Type: previous.Type,
    }
    if (
      Object.hasOwn(context.image.Config?.Volumes ?? {}, previous.Destination)
    ) {
      mounts.set(previous.Destination, inherited)
    }
    volumes = volumes.filter((volume) => {
      if (volume.target !== previous.Destination || volume.source) return true
      mounts.set(previous.Destination, inherited)
      return false
    })
  }
  for (const volume of volumes) {
    mounts.set(volume.target, mountOf(volume, context.volumes))
  }
  const files = (
    references: ReadonlyArray<ComposeFileReference> | undefined,
    kind: "configs" | "secrets"
  ) => {
    for (const reference of references ?? []) {
      const defined = project[kind]?.[reference.source]
      if (!defined?.file) continue
      const target = fileTarget(reference, kind)
      if (mounts.has(target)) continue
      mounts.set(target, {
        ReadOnly: true,
        Source: defined.file,
        Target: target,
        Type: "bind",
        ...(kind === "secrets" && { BindOptions: {} }),
      })
    }
  }
  files(service.secrets, "secrets")
  files(service.configs, "configs")

  const binds: Array<string> = []
  const others: Array<Record<string, unknown>> = []
  for (const mount of mounts.values()) {
    const declared = (service.volumes ?? []).find(
      (volume) => volume.target === mount.Target
    )
    if (mount.Type === "bind" && declared) {
      const source = String(mount.Source)
      const volume: ComposeVolumeMount =
        declared.type === "bind" ? declared : { ...declared, source }
      if (!bindRequiresMountApi(volume)) {
        binds.push(bindString(source, volume))
        continue
      }
    }
    if (mount.Type === "volume" && declared) {
      const named = [...context.volumes.values()].includes(String(mount.Source))
      if (named && !volumeRequiresMountApi(declared)) {
        binds.push(bindString(String(mount.Source), declared))
        continue
      }
    }
    others.push(mount)
  }
  return { binds, mounts: others }
}

function mountOf(
  volume: ComposeVolumeMount,
  names: ReadonlyMap<string, string>
): Record<string, unknown> {
  const source =
    volume.type === "volume" && volume.source
      ? (names.get(volume.source) ?? volume.source)
      : (volume.source ?? "")
  // Bind options make it a bind, as Compose's buildMount has it.
  const bind = volume.type === "bind" ? volume.bind : undefined
  return {
    ...(volume.consistency && { Consistency: volume.consistency }),
    ReadOnly: volume.read_only ?? false,
    Source: source,
    Target: volume.target,
    Type: volume.type,
    ...(bind && {
      BindOptions: {
        CreateMountpoint: bind.create_host_path !== false,
        ...(bind.propagation && { Propagation: bind.propagation }),
        ...(bind.recursive === "disabled" && { NonRecursive: true }),
        ...(bind.recursive === "writable" && { ReadOnlyNonRecursive: true }),
        ...(bind.recursive === "readonly" && { ReadOnlyForceRecursive: true }),
      },
    }),
    ...(volume.type === "volume" &&
      volume.volume && {
        VolumeOptions: {
          ...(volume.volume.labels && { Labels: volume.volume.labels }),
          ...(volume.volume.nocopy && { NoCopy: true }),
          ...(volume.volume.subpath && { Subpath: volume.volume.subpath }),
        },
      }),
    ...(volume.type === "tmpfs" &&
      volume.tmpfs && {
        TmpfsOptions: {
          ...(volume.tmpfs.mode !== undefined && { Mode: volume.tmpfs.mode }),
          ...(volume.tmpfs.size !== undefined && {
            SizeBytes: volume.tmpfs.size,
          }),
        },
      }),
  }
}

// A bind that can't be a `Binds` string: one Docker mustn't create when
// missing, or with propagation or recursion options.
function bindRequiresMountApi(volume: ComposeVolumeMount): boolean {
  const bind = volume.bind
  if (!bind) return false
  return (
    bind.create_host_path === false ||
    bind.propagation !== undefined ||
    bind.recursive !== undefined
  )
}

function volumeRequiresMountApi(volume: ComposeVolumeMount): boolean {
  const options = volume.volume
  if (!options) return false
  return (
    Object.keys(options.labels ?? {}).length > 0 ||
    options.subpath !== undefined ||
    options.nocopy === true
  )
}

function bindString(source: string, volume: ComposeVolumeMount): string {
  const options = [
    volume.read_only ? "ro" : "rw",
    ...(volume.bind?.selinux ? [volume.bind.selinux] : []),
    ...(volume.bind?.propagation ? [volume.bind.propagation] : []),
    ...(volume.volume?.nocopy ? ["nocopy"] : []),
  ]
  return `${source}:${volume.target}:${options.join(",")}`
}

// Where a secret or config goes: secrets under /run/secrets unless their
// target is absolute, configs at /<name> unless they have one.
function fileTarget(
  reference: ComposeFileReference,
  kind: "configs" | "secrets"
): string {
  const target = reference.target ?? ""
  if (kind === "secrets") {
    if (!target) return `/run/secrets/${reference.source}`
    return target.startsWith("/") ? target : `/run/secrets/${target}`
  }
  if (!target) return `/${reference.source}`
  return target.startsWith("/") ? target : `/${target}`
}

/**
 * Secrets and configs given as text (from the environment, or inline) are
 * written into the container before it starts, as Compose writes them:
 * owned by the uid and gid they ask for, with their mode or 0444.
 */
function injectFiles(
  engine: DockerEngine,
  project: ComposeProject,
  name: string,
  service: ComposeService,
  id: string
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    for (const kind of ["secrets", "configs"] as const) {
      for (const reference of service[kind] ?? []) {
        const defined = project[kind]?.[reference.source]
        if (!defined || defined.file) continue
        let content = defined.content ?? ""
        if (defined.environment !== undefined) {
          const value = project.environment?.[defined.environment]
          if (value === undefined) {
            return yield* Effect.fail(
              new Error(
                `environment variable ${JSON.stringify(defined.environment)} required by ${kind.slice(0, -1)} ${JSON.stringify(defined.name)} is not set`
              )
            )
          }
          content = value
        }
        if (content === "") continue
        if (service.read_only) {
          return yield* Effect.fail(
            new Error(
              `cannot create ${kind.slice(0, -1)} ${JSON.stringify(defined.name)} in read-only service ${name}: \`file\` is the sole supported option`
            )
          )
        }
        const target =
          kind === "secrets"
            ? fileTarget(reference, kind)
            : reference.target || `/${reference.source}`
        yield* engine.copyToContainer(
          id,
          "/",
          tarOf(target, content, reference),
          {
            copyUidGid:
              reference.uid !== undefined || reference.gid !== undefined,
          }
        )
      }
    }
  })
}

function tarOf(
  target: string,
  content: string,
  reference: ComposeFileReference
) {
  return Effect.promise(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const archive = createTarPack()
        const chunks: Array<Buffer> = []
        archive.on("data", (chunk: unknown) => {
          chunks.push(chunk as Buffer)
        })
        archive.on("end", () => resolve(Buffer.concat(chunks)))
        archive.on("error", reject)
        archive.entry(
          {
            gid: Number(reference.gid ?? 0) || 0,
            mode: reference.mode ?? 0o444,
            mtime: new Date(),
            name: target,
            uid: Number(reference.uid ?? 0) || 0,
          },
          content
        )
        archive.finalize()
      })
  )
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
): [string, Record<string, unknown> | null] {
  if (service.network_mode) {
    const linked = /^service:(.+)$/u.exec(service.network_mode)?.[1]
    return [
      linked
        ? `container:${context.containerOf(linked) ?? linked}`
        : service.network_mode,
      null,
    ]
  }
  const keys = Object.entries(service.networks ?? {})
    .map(([key, settings]) => ({
      key,
      priority: settings?.priority ?? 0,
      settings,
    }))
    .sort((left, right) =>
      left.priority === right.priority
        ? left.key < right.key
          ? -1
          : 1
        : right.priority - left.priority
    )
  const endpoints: Record<string, unknown> = {}
  for (const [index, { key, settings }] of keys.entries()) {
    const network = context.networks.get(key) ?? key
    // The service's MAC address is the primary network's, unless that one
    // has its own.
    const mac =
      settings?.mac_address || (index === 0 ? service.mac_address : undefined)
    const driverOpts = settings?.interface_name
      ? {
          ...settings.driver_opts,
          "com.docker.network.endpoint.ifname": settings.interface_name,
        }
      : settings?.driver_opts
    endpoints[network] = {
      Aliases: [context.containerName, name, ...(settings?.aliases ?? [])],
      DriverOpts: driverOpts ?? null,
      ...(settings?.ipv4_address && { IPAddress: settings.ipv4_address }),
      // Compose sends the IPv6 address here too.
      ...(settings?.ipv6_address && { IPv6Gateway: settings.ipv6_address }),
      ...(settings?.gw_priority && { GwPriority: settings.gw_priority }),
      // Compose sends addresses for networks the service configures.
      IPAMConfig: settings
        ? {
            ...(settings.ipv4_address && {
              IPv4Address: settings.ipv4_address,
            }),
            ...(settings.ipv6_address && {
              IPv6Address: settings.ipv6_address,
            }),
            ...(settings.link_local_ips?.length && {
              LinkLocalIPs: settings.link_local_ips,
            }),
          }
        : null,
      Links: null,
      ...(mac && { MacAddress: mac }),
    }
  }
  const primary = keys[0]
  return [
    primary ? (context.networks.get(primary.key) ?? primary.key) : "none",
    endpoints,
  ]
}

// --------------------------------------------------------------- startup

// Waits for a dependency's condition. One that isn't required only warns
// when it fails, as Compose does.
function waitForDependency(
  engine: DockerEngine,
  id: string,
  service: string,
  settings: NonNullable<ComposeService["depends_on"]>[string],
  onLine: (line: string) => void
): Effect.Effect<void, Error> {
  const { condition, required } = settings
  if (condition === "service_started") return Effect.void
  const check = Effect.gen(function* () {
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
        if (state.Status === "exited") {
          if (state.ExitCode !== 0) {
            return yield* Effect.fail(
              new DependencyFailure(
                `service ${JSON.stringify(service)} didn't complete successfully: exit ${state.ExitCode}`,
                `optional dependency ${JSON.stringify(service)} didn't complete successfully: exit ${state.ExitCode}`
              )
            )
          }
          onLine(`Container ${name}  Exited`)
          return
        }
      } else {
        const failed = (reason: string) =>
          new DependencyFailure(
            `dependency failed to start: ${reason}`,
            `optional dependency ${JSON.stringify(service)} failed to start: ${reason}`
          )
        if (state.Status === "exited") {
          return yield* Effect.fail(
            failed(`container ${name} exited (${state.ExitCode})`)
          )
        }
        if (!state.Health) {
          return yield* Effect.fail(
            failed(`container ${name} has no healthcheck configured`)
          )
        }
        if (state.Health.Status === "healthy") {
          onLine(`Container ${name}  Healthy`)
          return
        }
        if (state.Health.Status === "unhealthy") {
          return yield* Effect.fail(failed(`container ${name} is unhealthy`))
        }
        if (state.Health.Status !== "starting") {
          return yield* Effect.fail(
            failed(
              `container ${name} had unexpected health status ${JSON.stringify(state.Health.Status)}`
            )
          )
        }
      }
      yield* Effect.sleep(500)
    }
  })
  return check.pipe(
    Effect.catchIf(
      (failure): failure is DependencyFailure =>
        failure instanceof DependencyFailure,
      (failure) => {
        if (required) return Effect.fail(new Error(failure.message))
        onLine(failure.optional)
        return Effect.void
      }
    )
  )
}

class DependencyFailure extends Error {
  constructor(
    message: string,
    readonly optional: string
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- helpers

// Services whose containers this one's shares a namespace or volumes with,
// which must exist first.
function linkedServices(service: ComposeService): Array<string> {
  const shared = [service.network_mode, service.ipc, service.pid]
    .map((mode) => /^service:(.+)$/u.exec(mode ?? "")?.[1])
    .filter((name): name is string => name !== undefined)
  return [
    ...shared,
    ...(service.volumes_from ?? []).flatMap((entry) =>
      entry.startsWith("container:") ? [] : [entry.split(":")[0]!]
    ),
  ]
}

function containerNameOf(container: ContainerSummary): string {
  return (container.Names[0] ?? container.Id).replace(/^\//u, "")
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/**
 * Compose's NetworkHash: the SHA-256 of the network's configuration as Go
 * marshals compose-go's NetworkConfig, so a network Compose created is
 * recognised as unchanged.
 */
export function networkHash(network: ComposeNetwork, name: string): string {
  const ipam = network.ipam
  const fields = [
    `"name":${goString(name)}`,
    ...(network.driver ? [`"driver":${goString(network.driver)}`] : []),
    ...(network.driver_opts && Object.keys(network.driver_opts).length > 0
      ? [`"driver_opts":${goMap(network.driver_opts)}`]
      : []),
    `"ipam":{${[
      ...(ipam?.driver ? [`"driver":${goString(ipam.driver)}`] : []),
      ...(ipam?.config?.length
        ? [
            `"config":[${ipam.config
              .map(
                (pool) =>
                  `{${[
                    ...(pool.subnet
                      ? [`"subnet":${goString(pool.subnet)}`]
                      : []),
                    ...(pool.gateway
                      ? [`"gateway":${goString(pool.gateway)}`]
                      : []),
                    ...(pool.ip_range
                      ? [`"ip_range":${goString(pool.ip_range)}`]
                      : []),
                    ...(pool.aux_addresses &&
                    Object.keys(pool.aux_addresses).length > 0
                      ? [`"aux_addresses":${goMap(pool.aux_addresses)}`]
                      : []),
                  ].join(",")}}`
              )
              .join(",")}]`,
          ]
        : []),
      ...(ipam?.options && Object.keys(ipam.options).length > 0
        ? [`"options":${goMap(ipam.options)}`]
        : []),
    ].join(",")}}`,
    ...(network.external ? [`"external":true`] : []),
    ...(network.internal ? [`"internal":true`] : []),
    ...(network.attachable ? [`"attachable":true`] : []),
    ...(network.labels && Object.keys(network.labels).length > 0
      ? [`"labels":${goMap(network.labels)}`]
      : []),
    ...(network.enable_ipv4 !== undefined
      ? [`"enable_ipv4":${network.enable_ipv4}`]
      : []),
    ...(network.enable_ipv6 !== undefined
      ? [`"enable_ipv6":${network.enable_ipv6}`]
      : []),
  ]
  return createHash("sha256")
    .update(`{${fields.join(",")}}`)
    .digest("hex")
}

/** Compose's VolumeHash, with the `local` driver it defaults to. */
export function volumeHash(volume: ComposeVolume, name: string): string {
  const fields = [
    `"name":${goString(name)}`,
    `"driver":${goString(volume.driver || "local")}`,
    ...(volume.driver_opts && Object.keys(volume.driver_opts).length > 0
      ? [`"driver_opts":${goMap(volume.driver_opts)}`]
      : []),
    ...(volume.external ? [`"external":true`] : []),
    ...(volume.labels && Object.keys(volume.labels).length > 0
      ? [`"labels":${goMap(volume.labels)}`]
      : []),
  ]
  return createHash("sha256")
    .update(`{${fields.join(",")}}`)
    .digest("hex")
}

// Go's encoding/json for a string: HTML-safe, with line separators escaped.
function goString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

// A Go map[string]string, its keys sorted.
function goMap(map: Readonly<Record<string, string>>): string {
  return `{${Object.keys(map)
    .sort()
    .map((key) => `${goString(key)}:${goString(map[key]!)}`)
    .join(",")}}`
}
