/**
 * Compose files, read as `docker compose config` read them: YAML with
 * anchors and merge keys, variables interpolated from the project's `.env`
 * and environment, relative paths resolved against the project directory,
 * and short syntax expanded to the long form. The result has the same shape
 * as `docker compose config --format json`, for the keys Relay supports.
 *
 * Keys Relay can't honor fail loading with an error naming them, instead of
 * being ignored. Keys that only Swarm reads are ignored, as Compose itself
 * ignores them when it runs containers.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { Effect, Predicate, Result } from "effect"
import { parseDocument } from "yaml"

import { shellWords } from "./shell-words.js"

export type ComposeDependencyCondition =
  | "service_completed_successfully"
  | "service_healthy"
  | "service_started"

export interface ComposeBuild {
  context: string
  dockerfile?: string
  dockerfile_inline?: string
  args?: Record<string, string>
  target?: string
  labels?: Record<string, string>
  no_cache?: boolean
  pull?: boolean
}

export interface ComposePort {
  target: number
  published?: string
  host_ip?: string
  protocol: "tcp" | "udp"
}

export interface ComposeVolumeMount {
  type: "bind" | "tmpfs" | "volume"
  /** A host path for binds, a volume key for named volumes. */
  source?: string
  target: string
  read_only?: boolean
  bind?: { propagation?: string; selinux?: "Z" | "z" }
  volume?: { nocopy?: boolean; subpath?: string }
  tmpfs?: { size?: number; mode?: number }
}

export interface ComposeServiceNetwork {
  aliases?: Array<string>
  ipv4_address?: string
  ipv6_address?: string
  mac_address?: string
  priority?: number
  driver_opts?: Record<string, string>
}

export interface ComposeHealthcheck {
  test: Array<string>
  /** Durations in nanoseconds. */
  interval?: number
  timeout?: number
  start_period?: number
  start_interval?: number
  retries?: number
}

export interface ComposeService {
  image?: string
  build?: ComposeBuild
  pull_policy?: "always" | "build" | "missing" | "never"
  command?: Array<string> | null
  entrypoint?: Array<string> | null
  environment?: Record<string, string>
  labels?: Record<string, string>
  container_name?: string
  hostname?: string
  domainname?: string
  user?: string
  working_dir?: string
  ports?: Array<ComposePort>
  expose?: Array<string>
  volumes?: Array<ComposeVolumeMount>
  volumes_from?: Array<string>
  tmpfs?: Array<string>
  networks?: Record<string, ComposeServiceNetwork | null>
  network_mode?: string
  depends_on?: Record<
    string,
    { condition: ComposeDependencyCondition; required: boolean; restart: boolean }
  >
  healthcheck?: ComposeHealthcheck
  restart?: string
  stop_signal?: string
  /** Seconds. */
  stop_grace_period?: number
  tty?: boolean
  stdin_open?: boolean
  init?: boolean
  privileged?: boolean
  read_only?: boolean
  cap_add?: Array<string>
  cap_drop?: Array<string>
  security_opt?: Array<string>
  devices?: Array<{ source: string; target: string; permissions: string }>
  group_add?: Array<string>
  sysctls?: Record<string, string>
  ulimits?: Record<string, { soft: number; hard: number }>
  extra_hosts?: Array<string>
  dns?: Array<string>
  dns_search?: Array<string>
  dns_opt?: Array<string>
  ipc?: string
  pid?: string
  cgroup?: string
  cgroup_parent?: string
  userns_mode?: string
  runtime?: string
  platform?: string
  mac_address?: string
  logging?: { driver?: string; options?: Record<string, string> }
  /** Bytes. */
  mem_limit?: number
  mem_reservation?: number
  memswap_limit?: number
  mem_swappiness?: number
  shm_size?: number
  oom_kill_disable?: boolean
  oom_score_adj?: number
  pids_limit?: number
  /** Nano CPUs. */
  cpus?: number
  cpu_shares?: number
  cpu_quota?: number
  cpu_period?: number
  cpuset?: string
  [key: string]: unknown
}

export interface ComposeNetwork {
  name?: string
  external?: boolean
  driver?: string
  driver_opts?: Record<string, string>
  internal?: boolean
  attachable?: boolean
  enable_ipv6?: boolean
  ipam?: {
    driver?: string
    config?: Array<{
      subnet?: string
      ip_range?: string
      gateway?: string
      aux_addresses?: Record<string, string>
    }>
    options?: Record<string, string>
  }
  labels?: Record<string, string>
  [key: string]: unknown
}

export interface ComposeVolume {
  name?: string
  external?: boolean
  driver?: string
  driver_opts?: Record<string, string>
  labels?: Record<string, string>
}

export interface ComposeProject {
  name: string
  services: Record<string, ComposeService>
  networks?: Record<string, unknown>
  volumes?: Record<string, ComposeVolume>
  [key: string]: unknown
}

export interface ComposeLoadOptions {
  readonly yaml: string
  readonly projectName: string
  /** Where relative paths and `.env` are, as Relay sees it. */
  readonly projectDirectory: string
  /** Variables for interpolation, which take precedence over `.env`. */
  readonly environment: Readonly<Record<string, string>>
  readonly onWarning: (message: string) => void
}

type Value = unknown
type Mapping = Record<string, Value>

class ComposeError extends Error {}

/** Reads a Compose file into its normalized project. */
export async function loadComposeProject(
  options: ComposeLoadOptions
): Promise<ComposeProject> {
  const document = parseDocument(options.yaml, {
    merge: true,
    prettyErrors: false,
  })
  const [problem] = [...document.errors, ...document.warnings]
  if (problem) {
    throw new ComposeError(
      /Unresolved tag/u.test(problem.message)
        ? `The Compose file uses a YAML tag Kiln doesn't support: ${problem.message.split("\n")[0]}`
        : `The Compose file is not valid YAML: ${problem.message.split("\n")[0]}`
    )
  }
  const raw: Value = document.toJS({ maxAliasCount: 1_000 })
  if (!isMapping(raw)) throw new ComposeError("The Compose file is empty")

  const dotenv = await readEnvFile(
    join(options.projectDirectory, ".env"),
    false,
    (name) => options.environment[name]
  )
  const variables: Record<string, string> = {
    ...dotenv,
    ...options.environment,
  }
  const warned = new Set<string>()
  const lookup = (name: string) => variables[name]
  const interpolated = interpolateTree(raw, lookup, (name) => {
    if (warned.has(name)) return
    warned.add(name)
    options.onWarning(
      `The "${name}" variable is not set. Defaulting to a blank string.`
    )
  })
  if (!isMapping(interpolated)) {
    throw new ComposeError("The Compose file is empty")
  }
  return normalizeProject(interpolated, options, lookup)
}

// ------------------------------------------------------------ project

const PROJECT_KEYS = new Set([
  "name",
  "networks",
  "services",
  "version",
  "volumes",
])
// Top-level keys Relay can't run.
const UNSUPPORTED_PROJECT_KEYS: Record<string, string> = {
  configs: "configs",
  include: "include",
  models: "models",
  secrets: "secrets",
}

async function normalizeProject(
  raw: Mapping,
  options: ComposeLoadOptions,
  lookup: (name: string) => string | undefined
): Promise<ComposeProject> {
  for (const key of Object.keys(raw)) {
    if (key.startsWith("x-") || PROJECT_KEYS.has(key)) continue
    throw unsupported(
      UNSUPPORTED_PROJECT_KEYS[key] ? `top-level \`${key}\`` : `the top-level key \`${key}\``
    )
  }
  if (raw.version !== undefined) {
    options.onWarning(
      "the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion"
    )
  }
  const rawServices = raw.services
  if (!isMapping(rawServices) || Object.keys(rawServices).length === 0) {
    throw new ComposeError("The Compose file has no services")
  }
  const services: Record<string, ComposeService> = {}
  const disabled = new Set<string>()
  for (const [name, value] of Object.entries(rawServices)) {
    const service = value ?? {}
    if (!isMapping(service)) {
      throw new ComposeError(`services.${name} must be a mapping`)
    }
    // Services in a profile run only when it's active, and Relay activates
    // none.
    if (service.profiles !== undefined) {
      disabled.add(name)
      continue
    }
    services[name] = await normalizeService(name, service, options, lookup)
  }
  for (const [name, service] of Object.entries(services)) {
    for (const [dependency, settings] of Object.entries(
      service.depends_on ?? {}
    )) {
      if (services[dependency]) continue
      if (!settings.required) {
        delete service.depends_on![dependency]
        continue
      }
      throw new ComposeError(
        disabled.has(dependency)
          ? `service "${dependency}" is required by "${name}" but is disabled by its profiles`
          : `service "${name}" depends on undefined service "${dependency}"`
      )
    }
    const networkService = /^service:(.+)$/u.exec(service.network_mode ?? "")
    if (networkService && !services[networkService[1]!]) {
      throw new ComposeError(
        `service "${name}" uses the network of undefined service "${networkService[1]}"`
      )
    }
  }
  dependencyOrder(services)

  const networks = normalizeNetworks(raw.networks, options.projectName)
  const volumes = normalizeVolumes(raw.volumes, options.projectName)
  // Services without networks join `default`, which exists when one does.
  const usesDefault = Object.values(services).some(
    (service) =>
      !service.network_mode &&
      (!service.networks || Object.hasOwn(service.networks, "default"))
  )
  for (const service of Object.values(services)) {
    if (!service.network_mode && !service.networks) {
      service.networks = { default: null }
    }
  }
  if (usesDefault && !networks.default) {
    networks.default = { name: `${options.projectName}_default` }
  }
  for (const [name, service] of Object.entries(services)) {
    for (const network of Object.keys(service.networks ?? {})) {
      if (!networks[network]) {
        throw new ComposeError(
          `service "${name}" refers to undefined network ${network}: invalid compose project`
        )
      }
    }
    for (const volume of service.volumes ?? []) {
      if (volume.type === "volume" && volume.source && !volumes[volume.source]) {
        throw new ComposeError(
          `service "${name}" refers to undefined volume ${volume.source}: invalid compose project`
        )
      }
    }
  }
  return {
    name: options.projectName,
    networks,
    services,
    ...(Object.keys(volumes).length > 0 && { volumes }),
  }
}

function normalizeNetworks(
  value: Value,
  project: string
): Record<string, ComposeNetwork> {
  const networks: Record<string, ComposeNetwork> = {}
  if (value === undefined || value === null) return networks
  if (!isMapping(value)) throw new ComposeError("networks must be a mapping")
  for (const [key, raw] of Object.entries(value)) {
    const network = raw ?? {}
    if (!isMapping(network)) {
      throw new ComposeError(`networks.${key} must be a mapping`)
    }
    const path = `networks.${key}`
    checkKeys(path, network, [
      "attachable",
      "driver",
      "driver_opts",
      "enable_ipv4",
      "enable_ipv6",
      "external",
      "internal",
      "ipam",
      "labels",
      "name",
    ])
    const external = externalFlag(network.external, path)
    const name =
      optionalString(network.name, `${path}.name`) ??
      externalName(network.external) ??
      (external ? key : `${project}_${key}`)
    if (external) {
      networks[key] = { external: true, name }
      continue
    }
    const ipam = network.ipam
    if (ipam !== undefined && !isMapping(ipam)) {
      throw new ComposeError(`${path}.ipam must be a mapping`)
    }
    networks[key] = {
      name,
      ...(network.driver !== undefined && {
        driver: requiredString(network.driver, `${path}.driver`),
      }),
      ...(network.driver_opts !== undefined && {
        driver_opts: stringMap(network.driver_opts, `${path}.driver_opts`),
      }),
      ...(network.internal !== undefined && {
        internal: bool(network.internal, `${path}.internal`),
      }),
      ...(network.attachable !== undefined && {
        attachable: bool(network.attachable, `${path}.attachable`),
      }),
      ...(network.enable_ipv6 !== undefined && {
        enable_ipv6: bool(network.enable_ipv6, `${path}.enable_ipv6`),
      }),
      ...(network.labels !== undefined && {
        labels: labelMap(network.labels, `${path}.labels`),
      }),
      ...(ipam && {
        ipam: {
          ...(ipam.driver !== undefined && {
            driver: requiredString(ipam.driver, `${path}.ipam.driver`),
          }),
          ...(ipam.options !== undefined && {
            options: stringMap(ipam.options, `${path}.ipam.options`),
          }),
          ...(ipam.config !== undefined && {
            config: list(ipam.config, `${path}.ipam.config`).map(
              (entry, index) => {
                const config = entry ?? {}
                if (!isMapping(config)) {
                  throw new ComposeError(
                    `${path}.ipam.config[${index}] must be a mapping`
                  )
                }
                return {
                  ...(config.subnet !== undefined && {
                    subnet: requiredString(config.subnet, `${path}.ipam.config.subnet`),
                  }),
                  ...(config.ip_range !== undefined && {
                    ip_range: requiredString(config.ip_range, `${path}.ipam.config.ip_range`),
                  }),
                  ...(config.gateway !== undefined && {
                    gateway: requiredString(config.gateway, `${path}.ipam.config.gateway`),
                  }),
                  ...(config.aux_addresses !== undefined && {
                    aux_addresses: stringMap(
                      config.aux_addresses,
                      `${path}.ipam.config.aux_addresses`
                    ),
                  }),
                }
              }
            ),
          }),
        },
      }),
    }
  }
  return networks
}

function normalizeVolumes(
  value: Value,
  project: string
): Record<string, ComposeVolume> {
  const volumes: Record<string, ComposeVolume> = {}
  if (value === undefined || value === null) return volumes
  if (!isMapping(value)) throw new ComposeError("volumes must be a mapping")
  for (const [key, raw] of Object.entries(value)) {
    const volume = raw ?? {}
    if (!isMapping(volume)) {
      throw new ComposeError(`volumes.${key} must be a mapping`)
    }
    const path = `volumes.${key}`
    checkKeys(path, volume, ["driver", "driver_opts", "external", "labels", "name"])
    const external = externalFlag(volume.external, path)
    const name =
      optionalString(volume.name, `${path}.name`) ??
      externalName(volume.external) ??
      (external ? key : `${project}_${key}`)
    volumes[key] = external
      ? { external: true, name }
      : {
          name,
          ...(volume.driver !== undefined && {
            driver: requiredString(volume.driver, `${path}.driver`),
          }),
          ...(volume.driver_opts !== undefined && {
            driver_opts: stringMap(volume.driver_opts, `${path}.driver_opts`),
          }),
          ...(volume.labels !== undefined && {
            labels: labelMap(volume.labels, `${path}.labels`),
          }),
        }
  }
  return volumes
}

// ------------------------------------------------------------ services

// Keys Relay can't honor when running a service, and why to say so.
const UNSUPPORTED_SERVICE_KEYS = new Set([
  "annotations",
  "blkio_config",
  "configs",
  "credential_spec",
  "device_cgroup_rules",
  "extends",
  "external_links",
  "gpus",
  "isolation",
  "label_file",
  "links",
  "models",
  "post_start",
  "pre_stop",
  "provider",
  "secrets",
  "storage_opt",
  "use_api_socket",
  "uts",
  "cpu_count",
  "cpu_percent",
  "cpu_rt_period",
  "cpu_rt_runtime",
])
// Keys with no effect on the containers `docker compose up` runs.
const IGNORED_SERVICE_KEYS = new Set(["attach", "develop"])

async function normalizeService(
  name: string,
  raw: Mapping,
  options: ComposeLoadOptions,
  lookup: (name: string) => string | undefined
): Promise<ComposeService> {
  const path = `services.${name}`
  const directory = options.projectDirectory
  for (const key of Object.keys(raw)) {
    if (UNSUPPORTED_SERVICE_KEYS.has(key)) {
      throw unsupported(`\`${key}\` on service "${name}"`)
    }
  }
  const service: ComposeService = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || key.startsWith("x-")) continue
    if (IGNORED_SERVICE_KEYS.has(key)) continue
    const at = `${path}.${key}`
    switch (key) {
      case "image":
        service.image = requiredString(value, at)
        break
      case "build":
        service.build = normalizeBuild(value, at, directory)
        break
      case "pull_policy": {
        const policy = requiredString(value, at)
        const normalized =
          policy === "if_not_present" ? "missing" : policy
        if (!["always", "build", "missing", "never"].includes(normalized)) {
          throw unsupported(`pull_policy "${policy}" on service "${name}"`)
        }
        service.pull_policy = normalized as ComposeService["pull_policy"]
        break
      }
      case "command":
      case "entrypoint":
        service[key] =
          value === null
            ? null
            : typeof value === "string"
              ? shellWords(value, `${at}`)
              : stringList(value, at)
        break
      case "environment":
        service.environment = environmentMap(value, at, lookup)
        break
      case "env_file":
        break
      case "labels":
        service.labels = labelMap(value, at)
        break
      case "container_name":
      case "hostname":
      case "domainname":
      case "user":
      case "working_dir":
      case "stop_signal":
      case "ipc":
      case "pid":
      case "cgroup":
      case "cgroup_parent":
      case "userns_mode":
      case "runtime":
      case "platform":
      case "mac_address":
      case "cpuset":
      case "network_mode":
        service[key] = scalarString(value, at)
        break
      case "restart": {
        const policy = scalarString(value, at)
        if (!/^(?:no|always|unless-stopped|on-failure(?::\d+)?)$/u.test(policy)) {
          throw new ComposeError(`${at} has an invalid restart policy "${policy}"`)
        }
        service.restart = policy
        break
      }
      case "tty":
      case "stdin_open":
      case "init":
      case "privileged":
      case "read_only":
      case "oom_kill_disable":
        service[key] = bool(value, at)
        break
      case "ports":
        service.ports = list(value, at).flatMap((entry) => ports(entry, at))
        break
      case "expose":
        service.expose = list(value, at).map((entry) => scalarString(entry, at))
        break
      case "volumes":
        service.volumes = list(value, at).map((entry) =>
          volumeMount(entry, at, directory)
        )
        break
      case "volumes_from":
        service.volumes_from = stringList(value, at)
        break
      case "tmpfs":
        service.tmpfs =
          typeof value === "string" ? [value] : stringList(value, at)
        break
      case "networks":
        service.networks = serviceNetworks(value, at)
        break
      case "depends_on":
        service.depends_on = dependencies(value, at)
        break
      case "healthcheck":
        service.healthcheck = healthcheck(value, at)
        break
      case "stop_grace_period":
        service.stop_grace_period = Math.ceil(duration(value, at) / 1e9)
        break
      case "cap_add":
      case "cap_drop":
      case "security_opt":
      case "group_add":
      case "dns_search":
      case "dns_opt":
        service[key] = stringList(value, at)
        break
      case "dns":
        service.dns = typeof value === "string" ? [value] : stringList(value, at)
        break
      case "devices":
        service.devices = list(value, at).map((entry) => device(entry, at))
        break
      case "sysctls":
        service.sysctls = keyValues(value, at)
        break
      case "ulimits":
        service.ulimits = ulimits(value, at)
        break
      case "extra_hosts":
        service.extra_hosts = extraHosts(value, at)
        break
      case "logging":
        service.logging = logging(value, at)
        break
      case "mem_limit":
      case "mem_reservation":
      case "memswap_limit":
      case "shm_size":
        service[key] = bytes(value, at)
        break
      case "mem_swappiness":
      case "oom_score_adj":
      case "pids_limit":
      case "cpu_shares":
      case "cpu_quota":
      case "cpu_period":
        service[key] = integer(value, at)
        break
      case "cpus":
        service.cpus = nanoCpus(value, at)
        break
      case "deploy":
        applyDeploy(service, value, at, name)
        break
      case "scale":
        if (integer(value, at) !== 1) throw replicas(name)
        break
      case "profiles":
        break
      default:
        throw unsupported(`\`${key}\` on service "${name}"`)
    }
  }
  if (raw.env_file !== undefined) {
    const files = await envFiles(raw.env_file, `${path}.env_file`, directory, lookup)
    service.environment = { ...files, ...service.environment }
  }
  if (!service.image && !service.build) {
    throw new ComposeError(
      `service "${name}" has neither an image nor a build context specified: invalid compose project`
    )
  }
  if (service.network_mode && service.networks) {
    throw new ComposeError(
      `service "${name}" declares networks and network_mode, which can't be used together`
    )
  }
  return service
}

function normalizeBuild(
  value: Value,
  at: string,
  directory: string
): ComposeBuild {
  if (typeof value === "string") {
    return { context: localPath(value, at, directory) }
  }
  if (!isMapping(value)) throw new ComposeError(`${at} must be a string or mapping`)
  for (const key of Object.keys(value)) {
    if (
      ![
        "args",
        "context",
        "dockerfile",
        "dockerfile_inline",
        "labels",
        "no_cache",
        "pull",
        "target",
      ].includes(key) &&
      !key.startsWith("x-")
    ) {
      throw unsupported(`\`build.${key}\` (${at})`)
    }
  }
  const build: ComposeBuild = {
    context: localPath(
      value.context === undefined ? "." : requiredString(value.context, `${at}.context`),
      `${at}.context`,
      directory
    ),
  }
  if (value.dockerfile !== undefined) {
    build.dockerfile = requiredString(value.dockerfile, `${at}.dockerfile`)
  }
  if (value.dockerfile_inline !== undefined) {
    build.dockerfile_inline = requiredString(
      value.dockerfile_inline,
      `${at}.dockerfile_inline`
    )
  }
  if (build.dockerfile && build.dockerfile_inline) {
    throw new ComposeError(`${at} can't have both dockerfile and dockerfile_inline`)
  }
  if (value.args !== undefined) build.args = keyValues(value.args, `${at}.args`)
  if (value.target !== undefined) {
    build.target = requiredString(value.target, `${at}.target`)
  }
  if (value.labels !== undefined) build.labels = labelMap(value.labels, `${at}.labels`)
  if (value.no_cache !== undefined) build.no_cache = bool(value.no_cache, `${at}.no_cache`)
  if (value.pull !== undefined) build.pull = bool(value.pull, `${at}.pull`)
  return build
}

// A local build context; Relay sends it to Docker itself.
function localPath(value: string, at: string, directory: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/)/iu.test(value)) {
    throw unsupported(`remote build contexts (${at})`)
  }
  return resolve(directory, expandHome(value))
}

function applyDeploy(
  service: ComposeService,
  value: Value,
  at: string,
  name: string
) {
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  if (value.replicas !== undefined && integer(value.replicas, `${at}.replicas`) !== 1) {
    throw replicas(name)
  }
  const resources = value.resources
  if (resources !== undefined) {
    if (!isMapping(resources)) throw new ComposeError(`${at}.resources must be a mapping`)
    const limits = resources.limits
    if (limits !== undefined) {
      if (!isMapping(limits)) throw new ComposeError(`${at}.resources.limits must be a mapping`)
      if (limits.cpus !== undefined) service.cpus = nanoCpus(limits.cpus, `${at}.resources.limits.cpus`)
      if (limits.memory !== undefined) service.mem_limit = bytes(limits.memory, `${at}.resources.limits.memory`)
      if (limits.pids !== undefined) service.pids_limit = integer(limits.pids, `${at}.resources.limits.pids`)
    }
    const reservations = resources.reservations
    if (reservations !== undefined) {
      if (!isMapping(reservations)) throw new ComposeError(`${at}.resources.reservations must be a mapping`)
      if (reservations.devices !== undefined || reservations.generic_resources !== undefined) {
        throw unsupported(`device reservations on service "${name}"`)
      }
      if (reservations.memory !== undefined) {
        service.mem_reservation = bytes(reservations.memory, `${at}.resources.reservations.memory`)
      }
    }
  }
  const policy = value.restart_policy
  if (policy !== undefined && service.restart === undefined) {
    if (!isMapping(policy)) throw new ComposeError(`${at}.restart_policy must be a mapping`)
    const condition = policy.condition === undefined ? "any" : requiredString(policy.condition, `${at}.restart_policy.condition`)
    const attempts =
      policy.max_attempts === undefined ? 0 : integer(policy.max_attempts, `${at}.restart_policy.max_attempts`)
    service.restart =
      condition === "none"
        ? "no"
        : condition === "on-failure"
          ? attempts > 0
            ? `on-failure:${attempts}`
            : "on-failure"
          : "always"
  }
}

function ports(value: Value, at: string): Array<ComposePort> {
  if (isMapping(value)) {
    if (value.target === undefined) throw new ComposeError(`${at} needs a target port`)
    return [
      {
        target: integer(value.target, `${at}.target`),
        ...(value.published !== undefined && {
          published: scalarString(value.published, `${at}.published`),
        }),
        ...(value.host_ip !== undefined && {
          host_ip: requiredString(value.host_ip, `${at}.host_ip`),
        }),
        protocol: protocol(value.protocol, at),
      },
    ]
  }
  const text = scalarString(value, at)
  const [spec = "", protocolText] = text.split("/")
  const proto = protocol(protocolText, at)
  // [host_ip:][published:]target, with IPv6 addresses in brackets.
  const match = /^(?:(?:(\[[^\]]*\]|[^:]*):)?([^:]*):)?([^:]+)$/u.exec(spec)
  if (!match) throw new ComposeError(`${at} has an invalid port "${text}"`)
  const hostIp = match[1]?.replace(/^\[|\]$/gu, "")
  const published = match[2] ?? ""
  const [targetStart, targetEnd] = range(match[3]!, at, text)
  const [publishedStart, publishedEnd] = published
    ? range(published, at, text)
    : [undefined, undefined]
  const count = targetEnd - targetStart + 1
  if (
    publishedStart !== undefined &&
    publishedEnd! - publishedStart + 1 !== count &&
    publishedEnd !== publishedStart
  ) {
    throw new ComposeError(`${at} has mismatched port ranges "${text}"`)
  }
  return Array.from({ length: count }, (_, index) => ({
    target: targetStart + index,
    ...(publishedStart !== undefined && {
      published:
        publishedEnd !== publishedStart && count > 1
          ? String(publishedStart + index)
          : publishedEnd !== publishedStart
            ? `${publishedStart}-${publishedEnd}`
            : String(publishedStart),
    }),
    ...(hostIp && { host_ip: hostIp }),
    protocol: proto,
  }))
}

function range(text: string, at: string, whole: string): [number, number] {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(text)
  if (!match) throw new ComposeError(`${at} has an invalid port "${whole}"`)
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (end < start || end > 65_535) {
    throw new ComposeError(`${at} has an invalid port "${whole}"`)
  }
  return [start, end]
}

function protocol(value: Value, at: string): "tcp" | "udp" {
  if (value === undefined || value === "" || value === "tcp") return "tcp"
  if (value === "udp") return "udp"
  throw unsupported(`port protocol ${String(value)} (${at})`)
}

function volumeMount(
  value: Value,
  at: string,
  directory: string
): ComposeVolumeMount {
  if (isMapping(value)) {
    const type = requiredString(value.type ?? "volume", `${at}.type`)
    if (type !== "bind" && type !== "volume" && type !== "tmpfs") {
      throw unsupported(`volumes of type ${type} (${at})`)
    }
    const target = requiredString(value.target, `${at}.target`)
    const mount: ComposeVolumeMount = { target, type }
    if (value.source !== undefined) {
      const source = requiredString(value.source, `${at}.source`)
      mount.source =
        type === "bind" ? resolve(directory, expandHome(source)) : source
    }
    if (value.read_only !== undefined) mount.read_only = bool(value.read_only, `${at}.read_only`)
    if (isMapping(value.bind)) {
      if (value.bind.propagation !== undefined) {
        mount.bind = { propagation: requiredString(value.bind.propagation, `${at}.bind.propagation`) }
      }
      if (value.bind.selinux !== undefined) {
        mount.bind = { ...mount.bind, selinux: requiredString(value.bind.selinux, `${at}.bind.selinux`) as "Z" | "z" }
      }
    }
    if (isMapping(value.volume)) {
      mount.volume = {
        ...(value.volume.nocopy !== undefined && { nocopy: bool(value.volume.nocopy, `${at}.volume.nocopy`) }),
        ...(value.volume.subpath !== undefined && { subpath: requiredString(value.volume.subpath, `${at}.volume.subpath`) }),
      }
    }
    if (isMapping(value.tmpfs)) {
      mount.tmpfs = {
        ...(value.tmpfs.size !== undefined && { size: bytes(value.tmpfs.size, `${at}.tmpfs.size`) }),
        ...(value.tmpfs.mode !== undefined && { mode: integer(value.tmpfs.mode, `${at}.tmpfs.mode`) }),
      }
    }
    if (type === "bind" && !mount.source) throw new ComposeError(`${at} needs a source`)
    return mount
  }
  const text = requiredString(value, at)
  const parts = splitVolumeSpec(text)
  if (parts.length === 1) return { target: parts[0]!, type: "volume" }
  const [source = "", target = "", mode] = parts
  if (!target) throw new ComposeError(`${at} has an invalid volume "${text}"`)
  const bind = /^[./~]/u.test(source) || isAbsolute(source)
  const mount: ComposeVolumeMount = bind
    ? { source: resolve(directory, expandHome(source)), target, type: "bind" }
    : { source, target, type: "volume" }
  for (const option of (mode ?? "").split(",").filter(Boolean)) {
    if (option === "ro") mount.read_only = true
    else if (option === "rw") mount.read_only = false
    else if (option === "z" || option === "Z") mount.bind = { ...mount.bind, selinux: option }
    else if (option === "nocopy") mount.volume = { nocopy: true }
    else if (/^r?(?:shared|slave|private)$/u.test(option)) {
      mount.bind = { ...mount.bind, propagation: option }
    } else if (!["cached", "delegated", "consistent"].includes(option)) {
      throw new ComposeError(`${at} has an invalid volume mode "${option}"`)
    }
  }
  return mount
}

// `source:target[:mode]`, allowing Windows-style drive letters.
function splitVolumeSpec(text: string): Array<string> {
  return text.split(":")
}

function serviceNetworks(
  value: Value,
  at: string
): Record<string, ComposeServiceNetwork | null> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => [scalarString(entry, at), null])
    )
  }
  if (!isMapping(value)) throw new ComposeError(`${at} must be a list or mapping`)
  const networks: Record<string, ComposeServiceNetwork | null> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) {
      networks[name] = null
      continue
    }
    if (!isMapping(raw)) throw new ComposeError(`${at}.${name} must be a mapping`)
    checkKeys(`${at}.${name}`, raw, [
      "aliases",
      "driver_opts",
      "gw_priority",
      "ipv4_address",
      "ipv6_address",
      "mac_address",
      "priority",
    ])
    networks[name] = {
      ...(raw.aliases !== undefined && { aliases: stringList(raw.aliases, `${at}.${name}.aliases`) }),
      ...(raw.ipv4_address !== undefined && {
        ipv4_address: requiredString(raw.ipv4_address, `${at}.${name}.ipv4_address`),
      }),
      ...(raw.ipv6_address !== undefined && {
        ipv6_address: requiredString(raw.ipv6_address, `${at}.${name}.ipv6_address`),
      }),
      ...(raw.mac_address !== undefined && {
        mac_address: requiredString(raw.mac_address, `${at}.${name}.mac_address`),
      }),
      ...(raw.priority !== undefined && { priority: integer(raw.priority, `${at}.${name}.priority`) }),
      ...(raw.driver_opts !== undefined && {
        driver_opts: stringMap(raw.driver_opts, `${at}.${name}.driver_opts`),
      }),
    }
  }
  return networks
}

function dependencies(value: Value, at: string): NonNullable<ComposeService["depends_on"]> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => [
        scalarString(entry, at),
        { condition: "service_started" as const, required: true, restart: false },
      ])
    )
  }
  if (!isMapping(value)) throw new ComposeError(`${at} must be a list or mapping`)
  return Object.fromEntries(
    Object.entries(value).map(([name, raw]) => {
      const settings = raw ?? {}
      if (!isMapping(settings)) throw new ComposeError(`${at}.${name} must be a mapping`)
      const condition =
        settings.condition === undefined
          ? "service_started"
          : requiredString(settings.condition, `${at}.${name}.condition`)
      if (
        !["service_started", "service_healthy", "service_completed_successfully"].includes(
          condition
        )
      ) {
        throw new ComposeError(`${at}.${name} has an invalid condition "${condition}"`)
      }
      return [
        name,
        {
          condition: condition as ComposeDependencyCondition,
          required:
            settings.required === undefined ? true : bool(settings.required, `${at}.${name}.required`),
          restart:
            settings.restart === undefined ? false : bool(settings.restart, `${at}.${name}.restart`),
        },
      ]
    })
  )
}

function healthcheck(value: Value, at: string): ComposeHealthcheck {
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  checkKeys(at, value, [
    "disable",
    "interval",
    "retries",
    "start_interval",
    "start_period",
    "test",
    "timeout",
  ])
  if (value.disable !== undefined && bool(value.disable, `${at}.disable`)) {
    return { test: ["NONE"] }
  }
  const test =
    value.test === undefined
      ? []
      : typeof value.test === "string"
        ? ["CMD-SHELL", value.test]
        : stringList(value.test, `${at}.test`)
  return {
    test,
    ...(value.interval !== undefined && { interval: duration(value.interval, `${at}.interval`) }),
    ...(value.timeout !== undefined && { timeout: duration(value.timeout, `${at}.timeout`) }),
    ...(value.start_period !== undefined && {
      start_period: duration(value.start_period, `${at}.start_period`),
    }),
    ...(value.start_interval !== undefined && {
      start_interval: duration(value.start_interval, `${at}.start_interval`),
    }),
    ...(value.retries !== undefined && { retries: integer(value.retries, `${at}.retries`) }),
  }
}

function device(value: Value, at: string) {
  if (isMapping(value)) {
    return {
      permissions:
        value.permissions === undefined ? "rwm" : requiredString(value.permissions, `${at}.permissions`),
      source: requiredString(value.source, `${at}.source`),
      target: requiredString(value.target ?? value.source, `${at}.target`),
    }
  }
  const [source = "", target = source, permissions = "rwm"] = requiredString(value, at).split(":")
  return { permissions, source, target }
}

function ulimits(value: Value, at: string) {
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  return Object.fromEntries(
    Object.entries(value).map(([name, limit]) => {
      if (isMapping(limit)) {
        return [
          name,
          {
            hard: integer(limit.hard, `${at}.${name}.hard`),
            soft: integer(limit.soft, `${at}.${name}.soft`),
          },
        ]
      }
      const both = integer(limit, `${at}.${name}`)
      return [name, { hard: both, soft: both }]
    })
  )
}

function extraHosts(value: Value, at: string): Array<string> {
  if (isMapping(value)) {
    return Object.entries(value).flatMap(([host, addresses]) =>
      (Array.isArray(addresses) ? addresses : [addresses]).map(
        (address) => `${host}:${scalarString(address, `${at}.${host}`)}`
      )
    )
  }
  return stringList(value, at).map((entry) => {
    const separator = entry.indexOf("=")
    return separator === -1 ? entry : `${entry.slice(0, separator)}:${entry.slice(separator + 1)}`
  })
}

function logging(value: Value, at: string) {
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  checkKeys(at, value, ["driver", "options"])
  return {
    ...(value.driver !== undefined && { driver: requiredString(value.driver, `${at}.driver`) }),
    ...(value.options !== undefined && value.options !== null && {
      options: stringMap(value.options, `${at}.options`),
    }),
  }
}

function environmentMap(
  value: Value,
  at: string,
  lookup: (name: string) => string | undefined
): Record<string, string> {
  const environment: Record<string, string> = {}
  const set = (name: string, raw: Value) => {
    if (raw === null || raw === undefined) {
      // A name without a value takes it from the project's environment,
      // and is left out when that has none.
      const found = lookup(name)
      if (found !== undefined) environment[name] = found
      return
    }
    environment[name] = scalarString(raw, `${at}.${name}`)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = scalarString(entry, at)
      const separator = text.indexOf("=")
      if (separator === -1) set(text, null)
      else set(text.slice(0, separator), text.slice(separator + 1))
    }
    return environment
  }
  if (!isMapping(value)) throw new ComposeError(`${at} must be a list or mapping`)
  for (const [name, raw] of Object.entries(value)) set(name, raw)
  return environment
}

async function envFiles(
  value: Value,
  at: string,
  directory: string,
  lookup: (name: string) => string | undefined
): Promise<Record<string, string>> {
  const entries = (typeof value === "string" ? [value] : list(value, at)).map(
    (entry) => {
      if (typeof entry === "string") return { path: entry, required: true }
      if (!isMapping(entry)) throw new ComposeError(`${at} entries must be paths`)
      if (entry.format !== undefined && entry.format !== "dotenv") {
        throw unsupported(`env_file format ${String(entry.format)} (${at})`)
      }
      return {
        path: requiredString(entry.path, `${at}.path`),
        required: entry.required === undefined ? true : bool(entry.required, `${at}.required`),
      }
    }
  )
  const environment: Record<string, string> = {}
  for (const entry of entries) {
    Object.assign(
      environment,
      await readEnvFile(
        resolve(directory, expandHome(entry.path)),
        entry.required,
        (name) => environment[name] ?? lookup(name)
      )
    )
  }
  return environment
}

// ---------------------------------------------------------- env files

/**
 * A dotenv file as Compose reads one: `KEY=value` lines, with `export`,
 * comments, single quotes kept literally, double quotes with escapes, and
 * variables in unquoted and double-quoted values.
 */
async function readEnvFile(
  path: string,
  required: boolean,
  lookup: (name: string) => string | undefined
): Promise<Record<string, string>> {
  const read = await Effect.runPromise(
    Effect.result(Effect.tryPromise(() => readFile(path, "utf8")))
  )
  if (Result.isFailure(read)) {
    const cause = read.failure.cause
    const missing = Predicate.hasProperty(cause, "code") && cause.code === "ENOENT"
    if (missing && !required) return {}
    if (missing) throw new ComposeError(`env file ${path} not found`)
    throw cause
  }
  const text = read.success
  return parseEnvFile(text.replace(/^﻿/u, ""), path, lookup)
}

export function parseEnvFile(
  text: string,
  path: string,
  lookup: (name: string) => string | undefined
): Record<string, string> {
  const values: Record<string, string> = {}
  const resolveName = (name: string) => values[name] ?? lookup(name)
  let index = 0
  let line = 1
  const fail = (reason: string): never => {
    throw new ComposeError(`${path} line ${line}: ${reason}`)
  }
  while (index < text.length) {
    // Skip blank lines and comments.
    const rest = text.slice(index)
    const blank = /^[ \t]*(?:#[^\n]*)?(?:\r?\n|$)/u.exec(rest)
    if (blank && blank[0].length > 0) {
      index += blank[0].length
      line += 1
      continue
    }
    const key = /^[ \t]*(?:export[ \t]+)?([A-Za-z_.][A-Za-z0-9_.-]*)[ \t]*(=|:)?[ \t]*/u.exec(rest)
    if (!key) fail("expected KEY=VALUE")
    index += key![0].length
    const name = key![1]!
    if (!key![2]) {
      // A name alone takes its value from the environment.
      const found = lookup(name)
      if (found !== undefined) values[name] = found
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end + 1
      line += 1
      continue
    }
    const quote = text[index]
    if (quote === "'" || quote === '"') {
      const close = findClosingQuote(text, index + 1, quote)
      if (close === -1) fail(`unterminated quoted value for ${name}`)
      const raw = text.slice(index + 1, close)
      line += raw.split("\n").length - 1
      values[name] =
        quote === "'"
          ? raw
          : interpolate(unescapeDouble(raw), resolveName, () => undefined, `${path}:${name}`)
      index = close + 1
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end + 1
      line += 1
      continue
    }
    const end = text.indexOf("\n", index)
    let raw = text.slice(index, end === -1 ? text.length : end).replace(/\r$/u, "")
    // An inline comment starts at a # after whitespace.
    raw = raw.replace(/\s+#.*$/u, "").trim()
    values[name] = interpolate(raw, resolveName, () => undefined, `${path}:${name}`)
    index = end === -1 ? text.length : end + 1
    line += 1
  }
  return values
}

function findClosingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\" && quote === '"') {
      index += 1
      continue
    }
    if (text[index] === quote) return index
  }
  return -1
}

function unescapeDouble(raw: string): string {
  return raw.replace(/\\(.)/gu, (_, character: string) =>
    character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character
  )
}

// ------------------------------------------------------- interpolation

function interpolateTree(
  value: Value,
  lookup: (name: string) => string | undefined,
  onUnset: (name: string) => void,
  path = ""
): Value {
  if (typeof value === "string") return interpolate(value, lookup, onUnset, path)
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      interpolateTree(entry, lookup, onUnset, `${path}[${index}]`)
    )
  }
  if (isMapping(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateTree(entry, lookup, onUnset, path ? `${path}.${key}` : key),
      ])
    )
  }
  return value
}

/**
 * Compose's variable syntax: `$NAME`, `${NAME}`, with `:-`, `-`, `:?`,
 * `?`, `:+`, and `+` modifiers whose words are interpolated too, and `$$`
 * for a literal `$`.
 */
export function interpolate(
  text: string,
  lookup: (name: string) => string | undefined,
  onUnset: (name: string) => void,
  path: string
): string {
  if (!text.includes("$")) return text
  let output = ""
  let index = 0
  const invalid = () =>
    new ComposeError(`Invalid template in ${path}: "${text}"`)
  while (index < text.length) {
    const character = text[index]!
    if (character !== "$") {
      output += character
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === "$") {
      output += "$"
      index += 2
      continue
    }
    if (next === "{") {
      let depth = 1
      let end = index + 2
      for (; end < text.length && depth > 0; end += 1) {
        if (text[end] === "{" && text[end - 1] === "$") depth += 1
        else if (text[end] === "}") depth -= 1
      }
      if (depth !== 0) throw invalid()
      const expression = text.slice(index + 2, end - 1)
      output += substitute(expression, lookup, onUnset, path, invalid)
      index = end
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(index + 1))?.[0]
    if (!name) {
      output += "$"
      index += 1
      continue
    }
    const found = lookup(name)
    if (found === undefined) onUnset(name)
    output += found ?? ""
    index += 1 + name.length
  }
  return output
}

function substitute(
  expression: string,
  lookup: (name: string) => string | undefined,
  onUnset: (name: string) => void,
  path: string,
  invalid: () => Error
): string {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/u.exec(expression)
  if (!match) throw invalid()
  const [, name = "", operator, word = ""] = match
  const found = lookup(name)
  const expand = () => interpolate(word, lookup, onUnset, path)
  const empty = found === undefined || found === ""
  switch (operator) {
    case undefined:
      if (found === undefined) onUnset(name)
      return found ?? ""
    case ":-":
      return empty ? expand() : found
    case "-":
      return found === undefined ? expand() : found
    case ":+":
      return empty ? "" : expand()
    case "+":
      return found === undefined ? "" : expand()
    case ":?":
    case "?":
      if (operator === ":?" ? empty : found === undefined) {
        throw new ComposeError(
          `required variable ${name} is missing a value${word ? `: ${expand()}` : ""}`
        )
      }
      return found!
    default:
      throw invalid()
  }
}

// ------------------------------------------------------------ ordering

/** Services in an order that starts each after what it depends on. */
export function dependencyOrder(
  services: Readonly<Record<string, ComposeService>>
): Array<string> {
  const order: Array<string> = []
  const state = new Map<string, "done" | "visiting">()
  const visit = (name: string, trail: Array<string>) => {
    const current = state.get(name)
    if (current === "done") return
    if (current === "visiting") {
      throw new ComposeError(
        `dependency cycle detected: ${[...trail, name].join(" -> ")}`
      )
    }
    state.set(name, "visiting")
    const service = services[name]
    const dependencies = Object.keys(service?.depends_on ?? {})
    const networkService = /^service:(.+)$/u.exec(service?.network_mode ?? "")?.[1]
    for (const dependency of [
      ...dependencies,
      ...(networkService ? [networkService] : []),
      ...(service?.volumes_from ?? [])
        .map((entry) => /^(?:service:)?([^:]+)/u.exec(entry)?.[1])
        .filter((entry): entry is string => !!entry && !!services[entry]),
    ].sort()) {
      if (services[dependency]) visit(dependency, [...trail, name])
    }
    state.set(name, "done")
    order.push(name)
  }
  for (const name of Object.keys(services).sort()) visit(name, [])
  return order
}

// --------------------------------------------------------------- values

function isMapping(value: Value): value is Mapping {
  return Predicate.isObject(value) && !Array.isArray(value)
}

function checkKeys(at: string, value: Mapping, allowed: ReadonlyArray<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !key.startsWith("x-")) {
      throw unsupported(`\`${key}\` in ${at}`)
    }
  }
}

function unsupported(what: string): ComposeError {
  return new ComposeError(
    `The Compose file uses ${what}, which Kiln doesn't support yet`
  )
}

function replicas(name: string): ComposeError {
  return new ComposeError(
    `service "${name}" asks for more than one container, which Kiln doesn't support: each service runs one`
  )
}

function list(value: Value, at: string): Array<Value> {
  if (!Array.isArray(value)) throw new ComposeError(`${at} must be a list`)
  return value
}

function requiredString(value: Value, at: string): string {
  if (typeof value !== "string") throw new ComposeError(`${at} must be a string`)
  return value
}

function optionalString(value: Value, at: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, at)
}

// Numbers and booleans in string positions are their YAML text.
function scalarString(value: Value, at: string): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  throw new ComposeError(`${at} must be a string`)
}

function stringList(value: Value, at: string): Array<string> {
  return list(value, at).map((entry) => scalarString(entry, at))
}

function stringMap(value: Value, at: string): Record<string, string> {
  if (value === null) return {}
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === null ? "" : scalarString(entry, `${at}.${key}`),
    ])
  )
}

// `KEY: value` mappings or `KEY=value` lists.
function keyValues(value: Value, at: string): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const text = scalarString(entry, at)
        const separator = text.indexOf("=")
        return separator === -1
          ? [text, ""]
          : [text.slice(0, separator), text.slice(separator + 1)]
      })
    )
  }
  return stringMap(value, at)
}

function labelMap(value: Value, at: string): Record<string, string> {
  return keyValues(value, at)
}

function bool(value: Value, at: string): boolean {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new ComposeError(`${at} must be true or false`)
}

function integer(value: Value, at: string): number {
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new ComposeError(`${at} must be a whole number`)
  }
  return number
}

function externalFlag(value: Value, at: string): boolean {
  if (value === undefined) return false
  if (isMapping(value)) return true
  return bool(value, `${at}.external`)
}

// The deprecated `external: { name: … }` form.
function externalName(value: Value): string | undefined {
  return isMapping(value) && typeof value.name === "string" ? value.name : undefined
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

/** Go durations, such as `1m30s`; a bare number is seconds. */
function duration(value: Value, at: string): number {
  if (typeof value === "number") return value * 1e9
  const text = requiredString(value, at)
  const units: Record<string, number> = {
    h: 3_600e9,
    m: 60e9,
    ms: 1e6,
    ns: 1,
    s: 1e9,
    us: 1e3,
    µs: 1e3,
  }
  let total = 0
  let consumed = 0
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu)) {
    if (match.index !== consumed) break
    total += Number(match[1]) * units[match[2]!]!
    consumed += match[0].length
  }
  if (consumed !== text.length || text.length === 0) {
    throw new ComposeError(`${at} has an invalid duration "${text}"`)
  }
  return Math.round(total)
}

/** Sizes as Compose reads them: bytes, or a number with a binary unit. */
function bytes(value: Value, at: string): number {
  if (typeof value === "number") return value
  const match = /^(\d+(?:\.\d+)?)\s*([bkmgtp])?(?:i?b)?$/iu.exec(
    requiredString(value, at).trim()
  )
  if (!match) throw new ComposeError(`${at} has an invalid size "${String(value)}"`)
  const exponent = "bkmgtp".indexOf((match[2] ?? "b").toLowerCase())
  return Math.trunc(Number(match[1]) * 1024 ** exponent)
}

function nanoCpus(value: Value, at: string): number {
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    throw new ComposeError(`${at} must be a number of CPUs`)
  }
  return Math.round(number * 1e9)
}
