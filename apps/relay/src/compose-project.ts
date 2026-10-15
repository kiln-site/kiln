/**
 * Compose files, read as `docker compose config` read them (compose-go):
 * YAML with anchors and merge keys, variables interpolated from the
 * project's `.env` and environment, relative paths resolved against the
 * project directory, short syntax expanded to the long form, and implicit
 * defaults and dependencies added. The result has the shape of
 * `docker compose config --format json`, for the keys Relay supports.
 *
 * Keys Relay can't honor fail loading with an error naming them, instead of
 * being ignored. Keys only Swarm reads are ignored, as Compose itself
 * ignores them when it runs containers.
 */
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { Effect, Predicate, Result } from "effect"
import { parseDocument } from "yaml"

import { cleanPath } from "./docker-patterns.js"
import { shellWords } from "./shell-words.js"

export type ComposeDependencyCondition =
  | "service_completed_successfully"
  | "service_healthy"
  | "service_started"

export interface ComposeBuild {
  context: string
  dockerfile?: string
  dockerfile_inline?: string
  /** Arguments without a value that the environment doesn't set are left out. */
  args?: Record<string, string>
  target?: string
  labels?: Record<string, string>
  no_cache?: boolean
  pull?: boolean
}

export interface ComposePort {
  target: number
  /** A port, a range Docker picks a free port from, or none. */
  published?: string
  host_ip?: string
  protocol: "sctp" | "tcp" | "udp"
}

export interface ComposeVolumeMount {
  type: "bind" | "tmpfs" | "volume"
  /** A host path for binds, a volume key for named volumes. */
  source?: string
  target: string
  read_only?: boolean
  consistency?: string
  /**
   * Bind options. Present for the short syntax and an explicit `bind:`, and
   * then the host path is created when missing unless `create_host_path`
   * is false.
   */
  bind?: {
    create_host_path?: false
    propagation?: string
    recursive?: string
    selinux?: "Z" | "z"
  }
  volume?: {
    labels?: Record<string, string>
    nocopy?: boolean
    subpath?: string
  }
  tmpfs?: { mode?: number; size?: number }
}

export interface ComposeServiceNetwork {
  aliases?: Array<string>
  driver_opts?: Record<string, string>
  gw_priority?: number
  interface_name?: string
  ipv4_address?: string
  ipv6_address?: string
  link_local_ips?: Array<string>
  mac_address?: string
  priority?: number
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

export interface ComposeDeviceRequest {
  capabilities: Array<string>
  /** -1 for all. */
  count: number
  device_ids?: Array<string>
  driver?: string
  options?: Record<string, string>
}

/** A secret or config a service mounts (`secrets:`, `configs:`). */
export interface ComposeFileReference {
  source: string
  target?: string
  uid?: string
  gid?: string
  /** File mode bits. */
  mode?: number
}

/** A top-level secret or config: a file, or text from the environment or inline. */
export interface ComposeFileObject {
  name: string
  file?: string
  environment?: string
  content?: string
}

export interface ComposeService {
  image?: string
  build?: ComposeBuild
  pull_policy?: "always" | "build" | "missing" | "never"
  command?: Array<string> | null
  entrypoint?: Array<string> | null
  /** A null value unsets the variable (`environment: { NAME: null }`). */
  environment?: Record<string, string | null>
  labels?: Record<string, string>
  annotations?: Record<string, string>
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
  secrets?: Array<ComposeFileReference>
  configs?: Array<ComposeFileReference>
  networks?: Record<string, ComposeServiceNetwork | null>
  network_mode?: string
  depends_on?: Record<
    string,
    {
      condition: ComposeDependencyCondition
      required: boolean
      restart: boolean
    }
  >
  healthcheck?: ComposeHealthcheck
  restart?: string
  /** `deploy.restart_policy`, which takes precedence over `restart`. */
  restart_policy?: { condition: string; max_attempts?: number }
  stop_signal?: string
  /** Nanoseconds. */
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
  device_cgroup_rules?: Array<string>
  /** GPUs (`gpus`) and device reservations (`deploy`). */
  device_requests?: Array<ComposeDeviceRequest>
  group_add?: Array<string>
  sysctls?: Record<string, string>
  storage_opt?: Record<string, string>
  ulimits?: Record<string, { soft: number; hard: number }>
  /** `host:address` entries. */
  extra_hosts?: Array<string>
  dns?: Array<string>
  dns_search?: Array<string>
  dns_opt?: Array<string>
  ipc?: string
  pid?: string
  uts?: string
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
  enable_ipv4?: boolean
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
  secrets?: Record<string, ComposeFileObject>
  configs?: Record<string, ComposeFileObject>
  /**
   * The variables the project was interpolated with: the environment, then
   * `.env`. Secrets and configs from the environment read it, and
   * `DOCKER_DEFAULT_PLATFORM` in it is the default platform.
   */
  environment?: Record<string, string>
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
type Lookup = (name: string) => string | undefined

class ComposeError extends Error {}

// What variable substitution may produce: values of up to 1 MiB, and
// 16 MiB in all, so a file can't make loading build ever larger strings
// (`A=x`, then `A=${A}${A}` on each line, doubles A every line).
const MAX_SUBSTITUTED_VALUE = 1024 * 1024
const MAX_SUBSTITUTED_TOTAL = 16 * 1024 * 1024
// `.env` and env files are read whole; none is near this.
const MAX_FILE_BYTES = 4 * 1024 * 1024
// What a Compose file may come to with its aliases read as copies, as
// compose-go (go-yaml) reads them: a 62 KB file aliasing a 30,000-entry
// list 300 times is 9 million nodes. Real files are thousands.
const MAX_TREE_NODES = 1_000_000
const MAX_TREE_DEPTH = 256
// How deep `${A:-${B:-…}}` defaults may nest.
const MAX_SUBSTITUTION_DEPTH = 100

/** What one load's substitutions have produced so far. */
interface Expansion {
  total: number
  /** How deeply the substitution under way is nested in defaults. */
  depth: number
}

/**
 * Fails a file whose tree, with every alias read as a copy of what it
 * names, has more nodes or nests deeper than Relay reads, or names itself,
 * before anything walks it. Each shared node is counted once, by identity.
 */
function checkTree(root: Value): void {
  if (root === null || typeof root !== "object") return
  const sizes = new Map<object, number>()
  const heights = new Map<object, number>()
  const open = new Set<object>()
  const stack: Array<{
    readonly node: object
    readonly children: ReadonlyArray<Value>
    index: number
  }> = []
  const enter = (node: object) => {
    if (stack.length >= MAX_TREE_DEPTH) {
      throw new ComposeError(
        `The Compose file nests deeper than ${MAX_TREE_DEPTH} levels`
      )
    }
    open.add(node)
    stack.push({
      children: Array.isArray(node) ? node : Object.values(node),
      index: 0,
      node,
    })
  }
  enter(root)
  while (stack.length > 0) {
    const top = stack.at(-1)!
    if (top.index < top.children.length) {
      const child = top.children[top.index]
      top.index += 1
      if (child !== null && typeof child === "object") {
        if (open.has(child)) {
          throw new ComposeError("The Compose file has an alias that contains itself")
        }
        if (!sizes.has(child)) enter(child)
      }
      continue
    }
    stack.pop()
    open.delete(top.node)
    let size = 1
    let height = 1
    for (const child of top.children) {
      if (child !== null && typeof child === "object") {
        size += sizes.get(child)!
        height = Math.max(height, heights.get(child)! + 1)
      } else size += 1
    }
    if (size > MAX_TREE_NODES) {
      throw new ComposeError(
        `The Compose file comes to more than ${MAX_TREE_NODES} values with its aliases expanded`
      )
    }
    if (height > MAX_TREE_DEPTH) {
      throw new ComposeError(
        `The Compose file nests deeper than ${MAX_TREE_DEPTH} levels`
      )
    }
    sizes.set(top.node, size)
    heights.set(top.node, height)
  }
}

// Integers with a leading 0 are octal (`mode: 0440`), as in the YAML
// parser Compose uses, and not decimal as YAML 1.2 has them.
const LEGACY_OCTAL = {
  default: true,
  identify: (value: unknown) => typeof value === "number",
  resolve: (text: string) => Number.parseInt(text, 8),
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?0[0-7]+$/u,
}

/** Reads a Compose file into its normalized project. */
export async function loadComposeProject(
  options: ComposeLoadOptions
): Promise<ComposeProject> {
  const document = parseDocument(options.yaml, {
    customTags: (tags) => [LEGACY_OCTAL, ...tags],
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
  checkTree(raw)

  const expansion: Expansion = { depth: 0, total: 0 }
  const warned = new Set<string>()
  const onUnset = (name: string) => {
    if (warned.has(name)) return
    warned.add(name)
    options.onWarning(
      `The "${name}" variable is not set. Defaulting to a blank string.`
    )
  }
  // `.env` fills in what the environment doesn't set, and its own values
  // expand with the environment's first.
  const dotenv: Record<string, string> = {}
  const dotenvText = await readOptionalFile(
    join(options.projectDirectory, ".env")
  )
  if (dotenvText !== undefined) {
    parseDotenv(
      dotenvText,
      dotenv,
      (name) => options.environment[name],
      onUnset,
      join(options.projectDirectory, ".env"),
      expansion
    )
  }
  const variables: Record<string, string> = {
    ...dotenv,
    ...options.environment,
  }
  const lookup: Lookup = (name) =>
    Object.hasOwn(variables, name) ? variables[name] : undefined
  const interpolated = interpolateTree(
    raw,
    lookup,
    onUnset,
    "",
    expansion,
    new Map()
  )
  if (!isMapping(interpolated)) {
    throw new ComposeError("The Compose file is empty")
  }
  return normalizeProject(interpolated, options, variables, expansion)
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  const read = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise(() => stat(path)).pipe(
        Effect.flatMap((info) =>
          info.size > MAX_FILE_BYTES
            ? Effect.fail(
                new ComposeError(
                  `${path} is ${info.size} bytes; Kiln reads files of up to ${MAX_FILE_BYTES}`
                )
              )
            : Effect.tryPromise(() => readFile(path, "utf8"))
        )
      )
    )
  )
  if (Result.isSuccess(read)) return read.success
  if (read.failure instanceof ComposeError) throw read.failure
  const cause = read.failure.cause
  if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") {
    return undefined
  }
  throw cause
}

// ------------------------------------------------------------ project

const PROJECT_KEYS = new Set([
  "configs",
  "name",
  "networks",
  "secrets",
  "services",
  "version",
  "volumes",
])

async function normalizeProject(
  raw: Mapping,
  options: ComposeLoadOptions,
  variables: Record<string, string>,
  expansion: Expansion
): Promise<ComposeProject> {
  for (const key of Object.keys(raw)) {
    if (key.startsWith("x-") || PROJECT_KEYS.has(key)) continue
    throw unsupported(`the top-level key \`${key}\``)
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
  // Profiles the environment activates, as COMPOSE_PROFILES does.
  const profiles = new Set(
    (variables.COMPOSE_PROFILES ?? "")
      .split(",")
      .map((profile) => profile.trim())
      .filter(Boolean)
  )
  const lookup: Lookup = (name) =>
    Object.hasOwn(variables, name) ? variables[name] : undefined
  const services: Record<string, ComposeService> = {}
  const disabled = new Set<string>()
  for (const [name, value] of Object.entries(rawServices)) {
    const service = value ?? {}
    if (!isMapping(service)) {
      throw new ComposeError(`services.${name} must be a mapping`)
    }
    if (service.profiles !== undefined) {
      const own = stringList(service.profiles, `services.${name}.profiles`)
      // No profiles, even an empty list, means the service always runs.
      if (
        own.length > 0 &&
        !profiles.has("*") &&
        !own.some((profile) => profiles.has(profile))
      ) {
        disabled.add(name)
        continue
      }
    }
    services[name] = await normalizeService(
      name,
      service,
      options,
      lookup,
      expansion
    )
  }
  for (const [name, service] of Object.entries(services)) {
    implicitDependencies(service)
    for (const [dependency, settings] of Object.entries(
      service.depends_on ?? {}
    )) {
      if (services[dependency]) continue
      // An optional one is left out of the profiles that are active; it
      // stays listed, as in Compose, and isn't waited for.
      if (disabled.has(dependency) && !settings.required) continue
      throw new ComposeError(
        disabled.has(dependency)
          ? `service "${dependency}" is required by "${name}" but is disabled by its profiles`
          : `service "${name}" depends on undefined service "${dependency}": invalid compose project`
      )
    }
    if (service.depends_on && Object.keys(service.depends_on).length === 0) {
      delete service.depends_on
    }
  }
  dependencyOrder(services)

  const networks = normalizeNetworks(raw.networks, options.projectName)
  const volumes = normalizeVolumes(raw.volumes, options.projectName)
  const secrets = normalizeFileObjects(raw.secrets, "secrets", options)
  const configs = normalizeFileObjects(raw.configs, "configs", options)
  // Services without networks join `default`, which exists when one does.
  let usesDefault = false
  for (const service of Object.values(services)) {
    if (service.network_mode) continue
    if (!service.networks || Object.keys(service.networks).length === 0) {
      service.networks = { default: null }
    }
    if (Object.hasOwn(service.networks, "default")) usesDefault = true
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
      if (
        volume.type === "volume" &&
        volume.source &&
        !volumes[volume.source]
      ) {
        throw new ComposeError(
          `service "${name}" refers to undefined volume ${volume.source}: invalid compose project`
        )
      }
    }
    for (const [kind, defined] of [
      ["secret", secrets],
      ["config", configs],
    ] as const) {
      for (const reference of service[`${kind}s`] ?? []) {
        if (!defined[reference.source]) {
          throw new ComposeError(
            `service "${name}" refers to undefined ${kind} ${reference.source}: invalid compose project`
          )
        }
      }
    }
  }
  return {
    name: options.projectName,
    networks,
    services,
    ...(Object.keys(volumes).length > 0 && { volumes }),
    ...(Object.keys(secrets).length > 0 && { secrets }),
    ...(Object.keys(configs).length > 0 && { configs }),
    environment: variables,
  }
}

// Services this one shares a namespace or volumes with start first, as
// compose-go adds them to depends_on.
function implicitDependencies(service: ComposeService) {
  const dependsOn = service.depends_on ?? {}
  const add = (name: string, restart: boolean) => {
    dependsOn[name] ??= {
      condition: "service_started",
      required: true,
      restart,
    }
  }
  for (const mode of [
    service.network_mode,
    service.ipc,
    service.pid,
    service.uts,
    service.cgroup,
  ]) {
    if (mode?.startsWith("service:")) add(mode.slice("service:".length), true)
  }
  for (const entry of service.volumes_from ?? []) {
    if (!entry.startsWith("container:")) add(entry.split(":")[0]!, false)
  }
  if (Object.keys(dependsOn).length > 0) service.depends_on = dependsOn
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
    if (ipam !== undefined && ipam !== null && !isMapping(ipam)) {
      throw new ComposeError(`${path}.ipam must be a mapping`)
    }
    if (isMapping(ipam))
      checkKeys(`${path}.ipam`, ipam, ["config", "driver", "options"])
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
      ...(network.enable_ipv4 !== undefined && {
        enable_ipv4: bool(network.enable_ipv4, `${path}.enable_ipv4`),
      }),
      ...(network.enable_ipv6 !== undefined && {
        enable_ipv6: bool(network.enable_ipv6, `${path}.enable_ipv6`),
      }),
      ...(network.labels !== undefined && {
        labels: labelMap(network.labels, `${path}.labels`),
      }),
      ...(isMapping(ipam) && {
        ipam: {
          ...(ipam.driver !== undefined && {
            driver: requiredString(ipam.driver, `${path}.ipam.driver`),
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
                checkKeys(`${path}.ipam.config`, config, [
                  "aux_addresses",
                  "gateway",
                  "ip_range",
                  "subnet",
                ])
                return {
                  ...(config.subnet !== undefined && {
                    subnet: requiredString(
                      config.subnet,
                      `${path}.ipam.config.subnet`
                    ),
                  }),
                  ...(config.gateway !== undefined && {
                    gateway: requiredString(
                      config.gateway,
                      `${path}.ipam.config.gateway`
                    ),
                  }),
                  ...(config.ip_range !== undefined && {
                    ip_range: requiredString(
                      config.ip_range,
                      `${path}.ipam.config.ip_range`
                    ),
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
          ...(ipam.options !== undefined && {
            options: stringMap(ipam.options, `${path}.ipam.options`),
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
    checkKeys(path, volume, [
      "driver",
      "driver_opts",
      "external",
      "labels",
      "name",
    ])
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

// Top-level `secrets` or `configs`: files mounted read-only, or text
// written into the container.
function normalizeFileObjects(
  value: Value,
  kind: "configs" | "secrets",
  options: ComposeLoadOptions
): Record<string, ComposeFileObject> {
  const objects: Record<string, ComposeFileObject> = {}
  if (value === undefined || value === null) return objects
  if (!isMapping(value)) throw new ComposeError(`${kind} must be a mapping`)
  for (const [key, raw] of Object.entries(value)) {
    const object = raw ?? {}
    if (!isMapping(object))
      throw new ComposeError(`${kind}.${key} must be a mapping`)
    const path = `${kind}.${key}`
    checkKeys(path, object, [
      ...(kind === "configs" ? ["content"] : []),
      "environment",
      "external",
      "file",
      "labels",
      "name",
    ])
    if (externalFlag(object.external, path)) {
      throw unsupported(`the external ${kind.slice(0, -1)} "${key}"`)
    }
    const name =
      optionalString(object.name, `${path}.name`) ??
      `${options.projectName}_${key}`
    const sources = ["file", "environment", "content"].filter(
      (source) => object[source] !== undefined
    )
    if (sources.length !== 1) {
      throw new ComposeError(
        `${path} needs exactly one of file, environment${kind === "configs" ? ", or content" : ""}`
      )
    }
    objects[key] = {
      name,
      ...(object.file !== undefined && {
        file: resolve(
          options.projectDirectory,
          expandHome(requiredString(object.file, `${path}.file`))
        ),
      }),
      ...(object.environment !== undefined && {
        environment: requiredString(object.environment, `${path}.environment`),
      }),
      ...(object.content !== undefined && {
        content: requiredString(object.content, `${path}.content`),
      }),
    }
  }
  return objects
}

// ------------------------------------------------------------ services

// Keys Relay can't honor when running a service.
const UNSUPPORTED_SERVICE_KEYS = new Set([
  "blkio_config",
  "cpu_count",
  "cpu_percent",
  "cpu_rt_period",
  "cpu_rt_runtime",
  "credential_spec",
  "extends",
  "external_links",
  "isolation",
  "label_file",
  "links",
  "models",
  "post_start",
  "pre_start",
  "pre_stop",
  "provider",
  "use_api_socket",
  "volume_driver",
])
// Keys with no effect on the containers `docker compose up` runs.
const IGNORED_SERVICE_KEYS = new Set(["attach", "develop"])
// Every port of every protocol, which ranges can't add up past.
const MAX_SERVICE_PORTS = 3 * 65_536

function tooManyPorts(at: string): ComposeError {
  return new ComposeError(`${at} lists more than ${MAX_SERVICE_PORTS} ports`)
}

async function normalizeService(
  name: string,
  raw: Mapping,
  options: ComposeLoadOptions,
  lookup: Lookup,
  expansion: Expansion
): Promise<ComposeService> {
  const path = `services.${name}`
  const directory = options.projectDirectory
  for (const key of Object.keys(raw)) {
    if (UNSUPPORTED_SERVICE_KEYS.has(key)) {
      throw unsupported(`\`${key}\` on service "${name}"`)
    }
  }
  const service: ComposeService = {}
  let deploy: Mapping | undefined
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || key.startsWith("x-")) continue
    if (IGNORED_SERVICE_KEYS.has(key)) continue
    const at = `${path}.${key}`
    switch (key) {
      case "image":
        service.image = requiredString(value, at)
        break
      case "build":
        service.build = normalizeBuild(value, at, directory, lookup)
        break
      case "pull_policy": {
        const policy = requiredString(value, at)
        const normalized = policy === "if_not_present" ? "missing" : policy
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
              ? shellWords(value, at)
              : stringList(value, at)
        break
      case "environment":
        service.environment = environmentMap(value, at, lookup)
        break
      case "env_file":
        break
      case "labels":
      case "annotations":
        service[key] = labelMap(value, at)
        break
      case "container_name":
      case "hostname":
      case "domainname":
      case "user":
      case "working_dir":
      case "stop_signal":
      case "ipc":
      case "pid":
      case "uts":
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
      case "restart":
        service.restart = scalarString(value, at)
        break
      case "tty":
      case "stdin_open":
      case "init":
      case "privileged":
      case "read_only":
      case "oom_kill_disable":
        service[key] = bool(value, at)
        break
      case "ports": {
        // One per host address, published port, target, and protocol, the
        // last one's settings in the first one's place, as compose-go's
        // EnforceUnicity keeps them.
        const unique: Array<ComposePort> = []
        const indexes = new Map<string, number>()
        let count = 0
        for (const entry of list(value, at)) {
          for (const port of ports(entry, at)) {
            count += 1
            if (count > MAX_SERVICE_PORTS) throw tooManyPorts(at)
            const key = `${port.host_ip ?? "0.0.0.0"}:${port.published ?? "%!s(<nil>)"}:${port.target}/${port.protocol}`
            const index = indexes.get(key)
            if (index === undefined) {
              indexes.set(key, unique.length)
              unique.push(port)
            } else unique[index] = port
          }
        }
        service.ports = unique
        break
      }
      case "expose": {
        let count = 0
        const unique = new Set<string>()
        for (const entry of list(value, at)) {
          const text = scalarString(entry, at)
          const [ports = "", protocolText] = text.split("/")
          const [start, end] = range(ports, at, text)
          protocol(protocolText, at)
          count += end - start + 1
          if (count > MAX_SERVICE_PORTS) throw tooManyPorts(at)
          unique.add(text)
        }
        service.expose = [...unique]
        break
      }
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
      case "secrets":
        service.secrets = list(value, at).map((entry) => {
          const reference = fileReference(entry, at)
          return {
            ...reference,
            target: reference.target ?? `/run/secrets/${reference.source}`,
          }
        })
        break
      case "configs":
        service.configs = list(value, at).map((entry) =>
          fileReference(entry, at)
        )
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
        service.stop_grace_period = duration(value, at)
        break
      case "cap_add":
      case "cap_drop":
      case "security_opt":
      case "group_add":
      case "dns_search":
      case "dns_opt":
      case "device_cgroup_rules":
        service[key] = stringList(value, at)
        break
      case "dns":
        service.dns =
          typeof value === "string" ? [value] : stringList(value, at)
        break
      case "devices":
        service.devices = list(value, at).map((entry) => device(entry, at))
        break
      case "gpus":
        service.device_requests = [
          ...(service.device_requests ?? []),
          ...gpus(value, at),
        ]
        break
      case "sysctls":
      case "storage_opt":
        service[key] = keyValues(value, at)
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
        if (value !== null) {
          if (!isMapping(value))
            throw new ComposeError(`${at} must be a mapping`)
          deploy = value
        }
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
  // After the service's own keys, which deploy's must agree with.
  if (deploy) applyDeploy(service, deploy, `${path}.deploy`, name)
  const mounted = new Map<string, string>()
  // env_file values come first; environment's (resolved) override them,
  // and env_file values expand with the environment's.
  if (raw.env_file !== undefined && raw.env_file !== null) {
    const own = service.environment ?? {}
    const merged: Record<string, string> = Object.fromEntries(
      Object.entries(own).filter(
        (entry): entry is [string, string] => entry[1] !== null
      )
    )
    for (const file of envFileEntries(
      raw.env_file,
      `${path}.env_file`,
      directory
    )) {
      const text = await readOptionalFile(file.path)
      if (text === undefined) {
        if (file.required)
          throw new ComposeError(`env file ${file.path} not found`)
        continue
      }
      const resolve: Lookup = (variable) =>
        lookup(variable) ?? own[variable] ?? undefined
      if (file.raw) parseRawEnv(text, merged, resolve, file.path)
      else {
        parseDotenv(text, merged, resolve, () => undefined, file.path, expansion)
      }
    }
    service.environment = { ...merged, ...own }
  }
  for (const [index, entry] of (service.tmpfs ?? []).entries()) {
    const target = entry.split(":")[0]!
    if (mounted.has(target)) {
      throw new ComposeError(
        `${path}.tmpfs[${index}]: target ${target} already mounted as ${mounted.get(target)}`
      )
    }
    mounted.set(target, `${path}.tmpfs[${index}]`)
  }
  for (const [index, volume] of (service.volumes ?? []).entries()) {
    if (mounted.has(volume.target)) {
      throw new ComposeError(
        `${path}.volumes[${index}]: target ${volume.target} already mounted as ${mounted.get(volume.target)}`
      )
    }
    mounted.set(volume.target, `${path}.volumes[${index}]`)
  }
  const test = service.healthcheck?.test[0]
  if (test !== undefined && !["CMD", "CMD-SHELL", "NONE"].includes(test)) {
    throw new ComposeError(
      'healthcheck.test must start either by "CMD", "CMD-SHELL" or "NONE"'
    )
  }
  if (!service.image && !service.build) {
    throw new ComposeError(
      `service "${name}" has neither an image nor a build context specified: invalid compose project`
    )
  }
  if (service.network_mode && service.networks) {
    throw new ComposeError(
      `service "${name}" declares mutually exclusive \`network_mode\` and \`networks\``
    )
  }
  return service
}

function normalizeBuild(
  value: Value,
  at: string,
  directory: string,
  lookup: Lookup
): ComposeBuild {
  if (typeof value === "string") {
    return {
      context: localPath(value, at, directory),
      dockerfile: "Dockerfile",
    }
  }
  if (!isMapping(value))
    throw new ComposeError(`${at} must be a string or mapping`)
  checkKeys(at, value, [
    "args",
    "context",
    "dockerfile",
    "dockerfile_inline",
    "labels",
    "no_cache",
    "pull",
    "target",
  ])
  const build: ComposeBuild = {
    context: localPath(
      value.context === undefined || value.context === null
        ? "."
        : requiredString(value.context, `${at}.context`),
      `${at}.context`,
      directory
    ),
  }
  if (value.dockerfile !== undefined && value.dockerfile !== null) {
    build.dockerfile = requiredString(value.dockerfile, `${at}.dockerfile`)
  }
  if (
    value.dockerfile_inline !== undefined &&
    value.dockerfile_inline !== null
  ) {
    build.dockerfile_inline = requiredString(
      value.dockerfile_inline,
      `${at}.dockerfile_inline`
    )
  }
  if (build.dockerfile && build.dockerfile_inline) {
    throw new ComposeError(
      `${at} can't have both dockerfile and dockerfile_inline`
    )
  }
  if (build.dockerfile === undefined && build.dockerfile_inline === undefined) {
    build.dockerfile = "Dockerfile"
  }
  if (value.args !== undefined && value.args !== null) {
    // An argument without a value takes the environment's, and is left out
    // (so the Dockerfile's default applies) when that has none.
    const args: Record<string, string> = {}
    for (const [name, argument] of Object.entries(
      equalsMapping(value.args, `${at}.args`)
    )) {
      const resolved = argument ?? lookup(name)
      if (resolved !== undefined) args[name] = resolved
    }
    build.args = args
  }
  if (value.target !== undefined) {
    build.target = requiredString(value.target, `${at}.target`)
  }
  if (value.labels !== undefined)
    build.labels = labelMap(value.labels, `${at}.labels`)
  if (value.no_cache !== undefined)
    build.no_cache = bool(value.no_cache, `${at}.no_cache`)
  if (value.pull !== undefined) build.pull = bool(value.pull, `${at}.pull`)
  return build
}

// A local build context; Relay serves it to Docker itself.
function localPath(value: string, at: string, directory: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/)/iu.test(value)) {
    throw unsupported(`remote build contexts (${at})`)
  }
  return resolve(directory, expandHome(value))
}

function applyDeploy(
  service: ComposeService,
  value: Mapping,
  at: string,
  name: string
) {
  if (
    value.replicas !== undefined &&
    value.replicas !== null &&
    integer(value.replicas, `${at}.replicas`) !== 1
  ) {
    throw replicas(name)
  }
  const resources = value.resources
  if (resources !== undefined && resources !== null) {
    if (!isMapping(resources))
      throw new ComposeError(`${at}.resources must be a mapping`)
    // A service-level value and its deploy counterpart can't differ.
    const agree = (
      key: "cpus" | "mem_limit" | "mem_reservation" | "pids_limit",
      deployed: number,
      deployPath: string
    ) => {
      const own = service[key] ?? 0
      if (own !== 0 && own !== deployed) {
        throw new ComposeError(
          `services.${name}: can't set distinct values on '${key}' and '${deployPath}': invalid compose project`
        )
      }
      if (deployed !== 0 && (key !== "pids_limit" || deployed > 0))
        service[key] = deployed
    }
    const limits = resources.limits
    if (limits !== undefined && limits !== null) {
      if (!isMapping(limits))
        throw new ComposeError(`${at}.resources.limits must be a mapping`)
      agree(
        "cpus",
        limits.cpus === undefined
          ? 0
          : nanoCpus(limits.cpus, `${at}.resources.limits.cpus`),
        "deploy.resources.limits.cpus"
      )
      agree(
        "mem_limit",
        limits.memory === undefined
          ? 0
          : bytes(limits.memory, `${at}.resources.limits.memory`),
        "deploy.resources.limits.memory"
      )
      agree(
        "pids_limit",
        limits.pids === undefined
          ? 0
          : integer(limits.pids, `${at}.resources.limits.pids`),
        "deploy.resources.limits.pids"
      )
    }
    const reservations = resources.reservations
    if (reservations !== undefined && reservations !== null) {
      if (!isMapping(reservations)) {
        throw new ComposeError(`${at}.resources.reservations must be a mapping`)
      }
      if (reservations.generic_resources !== undefined) {
        throw unsupported(`generic resource reservations on service "${name}"`)
      }
      agree(
        "mem_reservation",
        reservations.memory === undefined
          ? 0
          : bytes(reservations.memory, `${at}.resources.reservations.memory`),
        "deploy.resources.reservations.memory"
      )
      if (reservations.devices !== undefined && reservations.devices !== null) {
        service.device_requests = [
          ...(service.device_requests ?? []),
          ...list(
            reservations.devices,
            `${at}.resources.reservations.devices`
          ).map((entry) =>
            deviceRequest(entry, `${at}.resources.reservations.devices`)
          ),
        ]
      }
    }
  }
  const policy = value.restart_policy
  if (policy !== undefined && policy !== null) {
    if (!isMapping(policy))
      throw new ComposeError(`${at}.restart_policy must be a mapping`)
    service.restart_policy = {
      condition:
        policy.condition === undefined || policy.condition === null
          ? ""
          : requiredString(policy.condition, `${at}.restart_policy.condition`),
      ...(policy.max_attempts !== undefined &&
        policy.max_attempts !== null && {
          max_attempts: integer(
            policy.max_attempts,
            `${at}.restart_policy.max_attempts`
          ),
        }),
    }
  }
}

function deviceRequest(value: Value, at: string): ComposeDeviceRequest {
  if (!isMapping(value))
    throw new ComposeError(`${at} entries must be mappings`)
  checkKeys(at, value, [
    "capabilities",
    "count",
    "device_ids",
    "driver",
    "options",
  ])
  return {
    capabilities:
      value.capabilities === undefined
        ? []
        : stringList(value.capabilities, `${at}.capabilities`),
    count:
      value.count === undefined
        ? value.device_ids === undefined
          ? -1
          : 0
        : String(value.count).toLowerCase() === "all"
          ? -1
          : integer(value.count, `${at}.count`),
    ...(value.device_ids !== undefined && {
      device_ids: stringList(value.device_ids, `${at}.device_ids`),
    }),
    ...(value.driver !== undefined && {
      driver: requiredString(value.driver, `${at}.driver`),
    }),
    ...(value.options !== undefined && {
      options: stringMap(value.options, `${at}.options`),
    }),
  }
}

// `gpus: all`, or a list of device requests; Docker adds the `gpu`
// capability.
function gpus(value: Value, at: string): Array<ComposeDeviceRequest> {
  if (value === "all") return [{ capabilities: ["gpu"], count: -1 }]
  return list(value, at).map((entry) => {
    const request = deviceRequest(entry, at)
    return { ...request, capabilities: [...request.capabilities, "gpu"] }
  })
}

function fileReference(value: Value, at: string): ComposeFileReference {
  if (typeof value === "string") return { source: value }
  if (!isMapping(value))
    throw new ComposeError(`${at} entries must be names or mappings`)
  checkKeys(at, value, ["gid", "mode", "source", "target", "uid"])
  return {
    source: requiredString(value.source, `${at}.source`),
    ...(value.target !== undefined && {
      target: requiredString(value.target, `${at}.target`),
    }),
    ...(value.uid !== undefined && {
      uid: scalarString(value.uid, `${at}.uid`),
    }),
    ...(value.gid !== undefined && {
      gid: scalarString(value.gid, `${at}.gid`),
    }),
    ...(value.mode !== undefined && {
      mode: fileMode(value.mode, `${at}.mode`),
    }),
  }
}

// A YAML number (octal with a leading 0, as Compose reads YAML) or an
// octal string, with or without its leading 0.
function fileMode(value: Value, at: string): number {
  const mode =
    typeof value === "string" && /^[0-7]+$/u.test(value)
      ? Number.parseInt(value, 8)
      : value
  if (
    typeof mode === "number" &&
    Number.isInteger(mode) &&
    mode >= 0 &&
    mode <= 0xff_ff_ff_ff
  ) {
    return mode
  }
  throw new ComposeError(`${at} must be a file mode`)
}

// `[host_ip:][published:]target[/protocol]`, as Docker's nat.ParsePortSpec
// reads it: a published range with a single target is a range Docker picks
// from.
function ports(value: Value, at: string): Array<ComposePort> {
  if (isMapping(value)) {
    if (value.target === undefined)
      throw new ComposeError(`${at} needs a target port`)
    return [
      {
        target: port(value.target, `${at}.target`),
        ...(value.published !== undefined &&
          value.published !== null &&
          value.published !== "" && {
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
  const parts = text.split(":")
  const containerPart = parts.at(-1)!
  const hostPort = parts.length >= 2 ? parts.at(-2)! : ""
  let hostIp = parts.length >= 3 ? parts.slice(0, -2).join(":") : ""
  const [targetText = "", protocolText] = containerPart.split("/")
  if (hostIp.startsWith("[") && hostIp.endsWith("]"))
    hostIp = hostIp.slice(1, -1)
  if (!targetText) throw new ComposeError(`${at} has no port in "${text}"`)
  const [targetStart, targetEnd] = range(targetText, at, text)
  const [publishedStart, publishedEnd] = hostPort
    ? range(hostPort, at, text)
    : [0, 0]
  if (
    hostPort &&
    targetEnd - targetStart !== publishedEnd - publishedStart &&
    targetEnd !== targetStart
  ) {
    throw new ComposeError(
      `${at}: invalid ranges specified for container and host Ports: ${targetText} and ${hostPort}`
    )
  }
  const proto = protocol(protocolText || "tcp", at)
  return Array.from({ length: targetEnd - targetStart + 1 }, (_, index) => {
    let published = hostPort ? String(publishedStart + index) : ""
    if (targetStart === targetEnd && publishedStart !== publishedEnd) {
      published = `${published}-${publishedEnd}`
    }
    return {
      target: targetStart + index,
      ...(published && { published }),
      ...(hostIp && { host_ip: hostIp }),
      protocol: proto,
    }
  })
}

function port(value: Value, at: string): number {
  const number = integer(value, at)
  if (number < 0 || number > 65_535) {
    throw new ComposeError(`${at} has an invalid port "${String(value)}"`)
  }
  return number
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

function protocol(value: Value, at: string): ComposePort["protocol"] {
  if (value === undefined || value === null || value === "") return "tcp"
  const text = scalarString(value, at).toLowerCase()
  if (text === "tcp" || text === "udp" || text === "sctp") return text
  throw new ComposeError(`${at} has an invalid protocol "${text}"`)
}

function volumeMount(
  value: Value,
  at: string,
  directory: string
): ComposeVolumeMount {
  if (isMapping(value)) {
    checkKeys(at, value, [
      "bind",
      "consistency",
      "read_only",
      "source",
      "target",
      "tmpfs",
      "type",
      "volume",
    ])
    const type = requiredString(value.type ?? "volume", `${at}.type`)
    if (type !== "bind" && type !== "volume" && type !== "tmpfs") {
      throw unsupported(`volumes of type ${type} (${at})`)
    }
    const mount: ComposeVolumeMount = {
      target: cleanPath(requiredString(value.target, `${at}.target`)),
      type,
    }
    if (
      value.source !== undefined &&
      value.source !== null &&
      value.source !== ""
    ) {
      const source = requiredString(value.source, `${at}.source`)
      mount.source =
        type === "bind" ? resolve(directory, expandHome(source)) : source
    }
    if (value.read_only !== undefined)
      mount.read_only = bool(value.read_only, `${at}.read_only`)
    if (value.consistency !== undefined) {
      mount.consistency = requiredString(value.consistency, `${at}.consistency`)
    }
    if (value.bind !== undefined && value.bind !== null) {
      if (!isMapping(value.bind))
        throw new ComposeError(`${at}.bind must be a mapping`)
      checkKeys(`${at}.bind`, value.bind, [
        "create_host_path",
        "propagation",
        "recursive",
        "selinux",
      ])
      const bindOptions = value.bind
      mount.bind = {
        ...(bindOptions.create_host_path !== undefined &&
          !bool(
            bindOptions.create_host_path,
            `${at}.bind.create_host_path`
          ) && {
            create_host_path: false as const,
          }),
        ...(bindOptions.propagation !== undefined && {
          propagation: requiredString(
            bindOptions.propagation,
            `${at}.bind.propagation`
          ),
        }),
        ...(bindOptions.recursive !== undefined && {
          recursive: requiredString(
            bindOptions.recursive,
            `${at}.bind.recursive`
          ),
        }),
        ...(bindOptions.selinux !== undefined && {
          selinux: requiredString(bindOptions.selinux, `${at}.bind.selinux`) as
            | "Z"
            | "z",
        }),
      }
    }
    if (value.volume !== undefined && value.volume !== null) {
      if (!isMapping(value.volume))
        throw new ComposeError(`${at}.volume must be a mapping`)
      checkKeys(`${at}.volume`, value.volume, ["labels", "nocopy", "subpath"])
      const volumeOptions = value.volume
      mount.volume = {
        ...(volumeOptions.labels !== undefined && {
          labels: labelMap(volumeOptions.labels, `${at}.volume.labels`),
        }),
        ...(volumeOptions.nocopy !== undefined && {
          nocopy: bool(volumeOptions.nocopy, `${at}.volume.nocopy`),
        }),
        ...(volumeOptions.subpath !== undefined && {
          subpath: requiredString(
            volumeOptions.subpath,
            `${at}.volume.subpath`
          ),
        }),
      }
    }
    if (value.tmpfs !== undefined && value.tmpfs !== null) {
      if (!isMapping(value.tmpfs))
        throw new ComposeError(`${at}.tmpfs must be a mapping`)
      checkKeys(`${at}.tmpfs`, value.tmpfs, ["mode", "size"])
      const tmpfsOptions = value.tmpfs
      mount.tmpfs = {
        ...(tmpfsOptions.mode !== undefined && {
          mode: fileMode(tmpfsOptions.mode, `${at}.tmpfs.mode`),
        }),
        ...(tmpfsOptions.size !== undefined && {
          size: bytes(tmpfsOptions.size, `${at}.tmpfs.size`),
        }),
      }
    }
    if (type === "bind" && !mount.source)
      throw new ComposeError(`${at} needs a source`)
    return mount
  }
  return shortVolume(requiredString(value, at), at, directory)
}

// compose-go's ParseVolume: `[source:]target[:options]`, where a source
// that's a path (starting with `.`, `/`, or `~`) is a bind that Docker
// creates when missing, and unknown options are ignored.
function shortVolume(
  spec: string,
  at: string,
  directory: string
): ComposeVolumeMount {
  if (spec.length === 0)
    throw new ComposeError(`${at}: invalid empty volume spec`)
  if (spec.length <= 2) return { target: spec, type: "volume", volume: {} }
  const fields: Array<string> = []
  let buffer = ""
  let depth = 0
  const characters = [...spec]
  for (let index = 0; index <= characters.length; index += 1) {
    const character = characters[index]
    if (character === "$" && characters[index + 1] === "{") {
      depth += 1
      buffer += character
      continue
    }
    if (character === "}" && depth > 0) {
      depth -= 1
      buffer += character
      continue
    }
    if ((character === ":" || character === undefined) && depth === 0) {
      if (buffer === "") {
        throw new ComposeError(
          `${at}: invalid spec: ${spec}: empty section between colons`
        )
      }
      if (fields.length === 2 && character === ":") {
        throw new ComposeError(`${at}: invalid spec: ${spec}: too many colons`)
      }
      fields.push(buffer)
      buffer = ""
      continue
    }
    buffer += character
  }
  const [first = "", second, options] = fields
  const source = second === undefined ? "" : first
  const target = cleanPath(second === undefined ? first : second)
  const bind = /^[./~]/u.test(source)
  const mount: ComposeVolumeMount = bind
    ? {
        bind: {},
        source: resolve(directory, expandHome(source)),
        target,
        type: "bind",
      }
    : { target, type: "volume", ...(source && { source }), volume: {} }
  for (const option of (options ?? "").split(",")) {
    if (option === "ro") mount.read_only = true
    else if (option === "rw") delete mount.read_only
    else if (option === "nocopy") mount.volume = { nocopy: true }
    else if (option === "z" || option === "Z") {
      mount.bind = { ...mount.bind, selinux: option }
    } else if (/^r?(?:shared|slave|private)$/u.test(option)) {
      mount.bind = { ...mount.bind, propagation: option }
    }
    // Other options are ignored, as compose-go ignores them.
  }
  if (mount.type === "volume" && mount.bind) {
    // Bind options on a named volume are kept, as compose-go keeps them,
    // and Docker reads them from the volume's binds string.
  }
  return mount
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
  if (!isMapping(value))
    throw new ComposeError(`${at} must be a list or mapping`)
  const networks: Record<string, ComposeServiceNetwork | null> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) {
      networks[name] = null
      continue
    }
    if (!isMapping(raw))
      throw new ComposeError(`${at}.${name} must be a mapping`)
    const path = `${at}.${name}`
    checkKeys(path, raw, [
      "aliases",
      "driver_opts",
      "gw_priority",
      "interface_name",
      "ipv4_address",
      "ipv6_address",
      "link_local_ips",
      "mac_address",
      "priority",
    ])
    networks[name] = {
      ...(raw.aliases !== undefined && {
        aliases: stringList(raw.aliases, `${path}.aliases`),
      }),
      ...(raw.driver_opts !== undefined && {
        driver_opts: stringMap(raw.driver_opts, `${path}.driver_opts`),
      }),
      ...(raw.gw_priority !== undefined && {
        gw_priority: integer(raw.gw_priority, `${path}.gw_priority`),
      }),
      ...(raw.interface_name !== undefined && {
        interface_name: requiredString(
          raw.interface_name,
          `${path}.interface_name`
        ),
      }),
      ...(raw.ipv4_address !== undefined && {
        ipv4_address: requiredString(raw.ipv4_address, `${path}.ipv4_address`),
      }),
      ...(raw.ipv6_address !== undefined && {
        ipv6_address: requiredString(raw.ipv6_address, `${path}.ipv6_address`),
      }),
      ...(raw.link_local_ips !== undefined && {
        link_local_ips: stringList(
          raw.link_local_ips,
          `${path}.link_local_ips`
        ),
      }),
      ...(raw.mac_address !== undefined && {
        mac_address: requiredString(raw.mac_address, `${path}.mac_address`),
      }),
      ...(raw.priority !== undefined && {
        priority: integer(raw.priority, `${path}.priority`),
      }),
    }
  }
  return networks
}

function dependencies(
  value: Value,
  at: string
): NonNullable<ComposeService["depends_on"]> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => [
        scalarString(entry, at),
        {
          condition: "service_started" as const,
          required: true,
          restart: false,
        },
      ])
    )
  }
  if (!isMapping(value))
    throw new ComposeError(`${at} must be a list or mapping`)
  return Object.fromEntries(
    Object.entries(value).map(([name, raw]) => {
      const settings = raw ?? {}
      if (!isMapping(settings))
        throw new ComposeError(`${at}.${name} must be a mapping`)
      checkKeys(`${at}.${name}`, settings, ["condition", "required", "restart"])
      if (settings.condition === undefined || settings.condition === null) {
        throw new ComposeError(`${at}.${name} missing property 'condition'`)
      }
      const condition = requiredString(
        settings.condition,
        `${at}.${name}.condition`
      )
      if (
        ![
          "service_started",
          "service_healthy",
          "service_completed_successfully",
        ].includes(condition)
      ) {
        throw new ComposeError(
          `${at}.${name} has an invalid condition "${condition}"`
        )
      }
      return [
        name,
        {
          condition: condition as ComposeDependencyCondition,
          required:
            settings.required === undefined
              ? true
              : bool(settings.required, `${at}.${name}.required`),
          restart:
            settings.restart === undefined
              ? false
              : bool(settings.restart, `${at}.${name}.restart`),
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
    value.test === undefined || value.test === null
      ? []
      : typeof value.test === "string"
        ? ["CMD-SHELL", value.test]
        : stringList(value.test, `${at}.test`)
  return {
    test,
    ...(value.interval !== undefined && {
      interval: duration(value.interval, `${at}.interval`),
    }),
    ...(value.timeout !== undefined && {
      timeout: duration(value.timeout, `${at}.timeout`),
    }),
    ...(value.start_period !== undefined && {
      start_period: duration(value.start_period, `${at}.start_period`),
    }),
    ...(value.start_interval !== undefined && {
      start_interval: duration(value.start_interval, `${at}.start_interval`),
    }),
    ...(value.retries !== undefined && {
      retries: integer(value.retries, `${at}.retries`),
    }),
  }
}

function device(value: Value, at: string) {
  if (isMapping(value)) {
    checkKeys(at, value, ["permissions", "source", "target"])
    return {
      permissions:
        value.permissions === undefined
          ? "rwm"
          : requiredString(value.permissions, `${at}.permissions`),
      source: requiredString(value.source, `${at}.source`),
      target: requiredString(value.target ?? value.source, `${at}.target`),
    }
  }
  const text = requiredString(value, at)
  // A CDI device name (`vendor/class=name`) stays whole.
  if (/^[^/:]+\/[^=:]+=[^:]+$/u.test(text)) {
    return { permissions: "rwm", source: text, target: text }
  }
  const [source = "", target = source, permissions = "rwm"] = text.split(":")
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

// `host:address` for each, as Docker takes them: from `host=address` or
// `host:address` entries, or a mapping, with brackets off IPv6 addresses.
function extraHosts(value: Value, at: string): Array<string> {
  const pairs: Array<[string, string]> = isMapping(value)
    ? Object.entries(value).flatMap(([host, addresses]) =>
        (Array.isArray(addresses) ? addresses : [addresses]).map(
          (address): [string, string] => [
            host,
            scalarString(address, `${at}.${host}`),
          ]
        )
      )
    : stringList(value, at).map((entry) => {
        const equals = entry.indexOf("=")
        const separator = equals === -1 ? entry.indexOf(":") : equals
        if (separator === -1) {
          throw new ComposeError(`${at} has an invalid extra host "${entry}"`)
        }
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      })
  return pairs.map(
    ([host, address]) =>
      `${host}:${address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address}`
  )
}

function logging(value: Value, at: string) {
  if (!isMapping(value)) throw new ComposeError(`${at} must be a mapping`)
  checkKeys(at, value, ["driver", "options"])
  return {
    ...(value.driver !== undefined && {
      driver: requiredString(value.driver, `${at}.driver`),
    }),
    ...(value.options !== undefined && {
      options: stringMap(value.options, `${at}.options`),
    }),
  }
}

// `environment`, with names without a value taken from the project's
// variables, or kept as null (unset) when it has none.
function environmentMap(
  value: Value,
  at: string,
  lookup: Lookup
): Record<string, string | null> {
  const environment: Record<string, string | null> = {}
  for (const [name, raw] of Object.entries(equalsMapping(value, at))) {
    environment[name] = raw ?? lookup(name) ?? null
  }
  return environment
}

// A `KEY: value` mapping or `KEY=value` list; a key without `=` (or with a
// null value) maps to null.
function equalsMapping(
  value: Value,
  at: string
): Record<string, string | null> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const text = scalarString(entry, at)
        const separator = text.indexOf("=")
        return separator === -1
          ? [text, null]
          : [text.slice(0, separator), text.slice(separator + 1)]
      })
    )
  }
  if (!isMapping(value))
    throw new ComposeError(`${at} must be a list or mapping`)
  return Object.fromEntries(
    Object.entries(value).map(([name, raw]) => [
      name,
      raw === null || raw === undefined
        ? null
        : scalarString(raw, `${at}.${name}`),
    ])
  )
}

function envFileEntries(
  value: Value,
  at: string,
  directory: string
): Array<{ path: string; raw: boolean; required: boolean }> {
  return (typeof value === "string" ? [value] : list(value, at)).map(
    (entry) => {
      if (typeof entry === "string") {
        return {
          path: resolve(directory, expandHome(entry)),
          raw: false,
          required: true,
        }
      }
      if (!isMapping(entry))
        throw new ComposeError(`${at} entries must be paths`)
      checkKeys(at, entry, ["format", "path", "required"])
      if (
        entry.format !== undefined &&
        entry.format !== "dotenv" &&
        entry.format !== "raw"
      ) {
        throw unsupported(`env_file format ${String(entry.format)} (${at})`)
      }
      return {
        raw: entry.format === "raw",
        path: resolve(
          directory,
          expandHome(requiredString(entry.path, `${at}.path`))
        ),
        required:
          entry.required === undefined
            ? true
            : bool(entry.required, `${at}.required`),
      }
    }
  )
}

// ---------------------------------------------------------- env files

/**
 * The `raw` env_file format, read with the parser `docker run --env-file`
 * uses (docker/cli's kvfile): each line is `KEY=value` as written, with no
 * quotes removed and no variables expanded. Leading whitespace and `#`
 * comment lines are skipped, and a key alone takes its value from `lookup`
 * or is left out.
 */
function parseRawEnv(
  text: string,
  out: Record<string, string>,
  lookup: Lookup,
  path: string
): void {
  const fail = (reason: string): never => {
    throw new ComposeError(`failed to parse env_file ${path}: ${reason}`)
  }
  for (const [index, scanned] of text.split("\n").entries()) {
    let line = scanned.endsWith("\r") ? scanned.slice(0, -1) : scanned
    if (index === 0 && line.startsWith("\uFEFF")) line = line.slice(1)
    line = line.replace(/^[^\S\uFEFF]+/u, "")
    if (line === "" || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    const key = separator === -1 ? line : line.slice(0, separator)
    if (key === "") fail(`no variable name on line '${line}'`)
    if (/[ \t]/u.test(key)) fail(`variable '${key}' contains whitespaces`)
    if (separator !== -1) {
      out[key] = line.slice(separator + 1)
      continue
    }
    const value = lookup(key)
    if (value !== undefined) out[key] = value
  }
}

/**
 * compose-go's dotenv parser: `KEY=value` (or `KEY: value`) statements,
 * with `export`, `#` comments, single quotes kept literally, double quotes
 * with escapes, unquoted values ending at ` #`, and variables expanded in
 * unquoted and double-quoted values. A key alone takes its value from
 * `lookup`. Values go into `out`; variables expand from `lookup` first,
 * then from what `out` already holds.
 */
function parseDotenv(
  text: string,
  out: Record<string, string>,
  lookup: Lookup,
  onUnset: (name: string) => void,
  path: string,
  expansion: Expansion
): void {
  let source = text.startsWith("\uFEFF") ? text.slice(1) : text
  let line = 1
  const fail = (reason: string): never => {
    throw new ComposeError(`failed to read ${path}: line ${line}: ${reason}`)
  }
  const expand = (value: string) =>
    substituteTemplate(
      value,
      (name) =>
        lookup(name) ?? (Object.hasOwn(out, name) ? out[name] : undefined),
      onUnset,
      path,
      expansion
    )
  const isSpace = (character: string) =>
    /^[\t\v\f\r \u0085\u00a0]$/u.test(character)
  for (;;) {
    // The next statement, past white space and comment lines.
    for (;;) {
      const start = source.search(/[^\s]/u)
      line += (
        source.slice(0, start === -1 ? source.length : start).match(/\n/gu) ??
        []
      ).length
      if (start === -1) return
      source = source.slice(start)
      if (!source.startsWith("#")) break
      const end = source.indexOf("\n")
      if (end === -1) return
      source = source.slice(end)
    }
    if (/^export\s/u.test(source)) {
      source = source
        .slice("export".length)
        .replace(/^[\t\v\f\r \u0085\u00a0]+/u, "")
    }
    // The key, up to `=`, `:`, or the end of the line (a key alone).
    let key = ""
    let offset = 0
    let inherited = false
    for (let index = 0; index < source.length;) {
      const character = String.fromCodePoint(source.codePointAt(index)!)
      if (character === "=" || character === ":" || character === "\n") {
        key = source.slice(0, index)
        offset = index + 1
        inherited = character === "\n"
        break
      }
      if (!isSpace(character) && !/^[\p{L}\p{N}_.\-[\]]$/u.test(character)) {
        fail(
          `unexpected character ${JSON.stringify(character)} in variable name ${JSON.stringify(source.split("\n")[0])}`
        )
      }
      index += character.length
    }
    if (inherited && !key.includes(" ")) line += 1
    key = key.replace(/\s+$/u, "")
    if (key.includes(" ")) fail("key cannot contain a space")
    source = source.slice(offset).replace(/^[\t\v\f\r \u0085\u00a0]+/u, "")
    if (inherited) {
      const value = lookup(key)
      if (value !== undefined) out[key] = value
      continue
    }
    const quote = source[0]
    if (quote !== '"' && quote !== "'") {
      const end = source.indexOf("\n")
      let value = end === -1 ? source : source.slice(0, end)
      source = end === -1 ? "" : source.slice(end + 1)
      line += 1
      const comment = value.indexOf(" #")
      if (comment !== -1) value = value.slice(0, comment)
      out[key] = expand(value.replace(/\s+$/u, ""))
      continue
    }
    // A quoted value, which can span lines.
    let value = ""
    let escaped = false
    let closed = -1
    for (let index = 1; index < source.length; index += 1) {
      const character = source[index]!
      if (character === "\n") line += 1
      if (character !== quote) {
        if (!escaped && character === "\\") {
          escaped = true
          continue
        }
        if (escaped) {
          escaped = false
          value += "\\"
        }
        value += character
        continue
      }
      if (escaped) {
        escaped = false
        value += character
        continue
      }
      closed = index
      break
    }
    if (closed === -1) {
      const end = source.indexOf("\n")
      fail(
        `unterminated quoted value ${end === -1 ? source : source.slice(0, end)}`
      )
    }
    out[key] = quote === '"' ? expand(expandEscapes(value)) : value
    source = source.slice(closed + 1)
  }
}

// The shell escapes Compose expands in double-quoted values: `\a` through
// `\v`, `\$` (a literal `$`), `\"`, `\\`, and octal `\0NNN`.
function expandEscapes(value: string): string {
  return value.replace(/\\(?:[abcfnrtv$"\\]|0\d{0,3})/gu, (match) => {
    if (match === "\\$") return "$$"
    const escapes: Record<string, string> = {
      "\\\\": "\\",
      '\\"': '"',
      "\\a": "\u0007",
      "\\b": "\b",
      "\\f": "\f",
      "\\n": "\n",
      "\\r": "\r",
      "\\t": "\t",
      "\\v": "\v",
    }
    if (escapes[match] !== undefined) return escapes[match]
    if (match === "\\c") return match
    // `\0NNN` is octal NNN. Compose drops the 0 before reading it, so what
    // it can't read is left without the 0 (and a lone `\0` as `\`).
    const digits = match.slice(2)
    if (!/^[0-7]{3}$/u.test(digits)) return `\\${digits}`
    const code = Number.parseInt(digits, 8)
    return code > 0xff ? `\\${digits}` : String.fromCharCode(code)
  })
}

// ------------------------------------------------------- interpolation

// An aliased node is one object wherever it's used; it's interpolated
// once, as it reads the same everywhere. `checkTree` bounds the depth.
function interpolateTree(
  value: Value,
  lookup: Lookup,
  onUnset: (name: string) => void,
  path: string,
  expansion: Expansion,
  done: Map<object, Value>
): Value {
  if (typeof value === "string")
    return substituteTemplate(value, lookup, onUnset, path, expansion)
  if (value === null || typeof value !== "object") return value
  if (done.has(value)) return done.get(value)
  let result: Value = value
  if (Array.isArray(value)) {
    result = value.map((entry, index) =>
      interpolateTree(
        entry,
        lookup,
        onUnset,
        `${path}[${index}]`,
        expansion,
        done
      )
    )
  } else if (isMapping(value)) {
    result = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        interpolateTree(
          entry,
          lookup,
          onUnset,
          path ? `${path}.${key}` : key,
          expansion,
          done
        ),
      ])
    )
  }
  done.set(value, result)
  return result
}

// compose-go's template pattern: `$$`, `$NAME`, or `${NAME[op word]}`
// (greedy up to the last `}` on the line, then cut at the first closing
// brace), or a `${` that's none of these.
const TEMPLATE =
  /\$(?:(\$)|([_a-z][_a-z0-9]*)|\{(?:([_a-z][_a-z0-9]*(?::?[-+?][^\n]*)?)\}|()))/giu

/**
 * Compose's variable substitution (compose-go's `template.Substitute`):
 * `$NAME`, `${NAME}`, the `:-`, `-`, `:?`, `?`, `:+`, and `+` modifiers
 * (whose words are substituted too), and `$$` for a literal `$`.
 */
function substituteTemplate(
  text: string,
  lookup: Lookup,
  onUnset: (name: string) => void,
  path: string,
  expansion: Expansion
): string {
  if (!text.includes("$")) return text
  // Each template in turn: one with a default is cut at its first closing
  // brace, and what follows it is read on from there, as compose-go reads
  // it (recursively, which a long line of them would overflow).
  const template = new RegExp(TEMPLATE.source, "giu")
  let output = ""
  let position = 0
  for (;;) {
    template.lastIndex = position
    const match = template.exec(text)
    if (!match) break
    const replaced = Result.try(() =>
      replacement(match[0], lookup, onUnset, expansion)
    )
    if (Result.isFailure(replaced)) {
      const failure =
        replaced.failure instanceof InvalidTemplate
          ? new ComposeError(`Invalid template: ${JSON.stringify(text)}`)
          : replaced.failure instanceof ComposeError
            ? replaced.failure
            : new ComposeError(String(replaced.failure))
      throw interpolationError(path, failure)
    }
    const [value, consumed] = replaced.success
    // Checked before the piece joins the result.
    expansion.total += value.length
    if (output.length + (match.index - position) + value.length > MAX_SUBSTITUTED_VALUE) {
      throw interpolationError(
        path,
        new ComposeError(
          `a value is longer than ${MAX_SUBSTITUTED_VALUE} characters once its variables are substituted`
        )
      )
    }
    if (expansion.total > MAX_SUBSTITUTED_TOTAL) {
      throw interpolationError(
        path,
        new ComposeError(
          `substituting variables produces more than ${MAX_SUBSTITUTED_TOTAL} characters`
        )
      )
    }
    output += text.slice(position, match.index) + value
    position = match.index + consumed
  }
  return output + text.slice(position)
}

function interpolationError(path: string, failure: ComposeError): ComposeError {
  return new ComposeError(
    path
      ? `error while interpolating ${path}: ${failure.message}`
      : failure.message
  )
}

class InvalidTemplate extends Error {}

const OPERATORS = [":?", "?", ":-", "-", ":+", "+"] as const

// The value of the first template in `matched`, and how much of `matched`
// it takes: up to its first closing brace when it has a default.
function replacement(
  matched: string,
  lookup: Lookup,
  onUnset: (name: string) => void,
  expansion: Expansion
): readonly [string, number] {
  // The operator is the one that appears first in the whole match.
  const operator = [...OPERATORS]
    .filter((candidate) => matched.includes(candidate))
    .sort((left, right) => matched.indexOf(left) - matched.indexOf(right))[0]
  const closing = firstClosingBrace(matched)
  let template = matched
  if (closing > -1) template = template.slice(0, closing + 1)
  const match = new RegExp(TEMPLATE.source, "iu").exec(template)
  if (match?.[1]) return ["$", matched.length]
  let name = match?.[2] ?? ""
  let braced = false
  if (!name) {
    name = match?.[3] ?? ""
    braced = true
  }
  if (!name) throw new InvalidTemplate()
  if (braced && operator && name.includes(operator)) {
    const separator = name.indexOf(operator)
    const variable = name.slice(0, separator)
    const word = name.slice(separator + operator.length)
    const value = lookup(variable)
    const nested = (text: string) => {
      if (expansion.depth >= MAX_SUBSTITUTION_DEPTH) {
        throw new ComposeError(
          `variable defaults nest more than ${MAX_SUBSTITUTION_DEPTH} deep`
        )
      }
      expansion.depth += 1
      const value = Result.try(() =>
        substituteTemplate(text, lookup, onUnset, "", expansion)
      )
      expansion.depth -= 1
      if (Result.isFailure(value)) throw value.failure
      return value.success
    }
    let substituted: string
    switch (operator) {
      case ":-":
      case "-":
        substituted =
          value === undefined || (operator === ":-" && value === "")
            ? nested(word)
            : value
        break
      case ":+":
      case "+":
        substituted =
          value !== undefined && (operator === "+" || value !== "")
            ? nested(word)
            : (value ?? "")
        break
      default:
        if (value === undefined || (operator === ":?" && value === "")) {
          const reason = nested(word)
          throw new ComposeError(
            reason
              ? `required variable ${variable} is missing a value: ${reason}`
              : `required variable ${variable} is missing a value`
          )
        }
        substituted = value
    }
    return [substituted, template.length]
  }
  const value = lookup(name)
  if (value === undefined) onUnset(name)
  return [value ?? "", matched.length]
}

// compose-go's getFirstBraceClosingIndex, which skips the character after
// each `{`.
function firstClosingBrace(text: string): number {
  let open = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "}") {
      open -= 1
      if (open === 0) return index
    }
    if (text[index] === "{") {
      open += 1
      index += 1
    }
  }
  return -1
}

// ------------------------------------------------------------ ordering

/** Services in an order that starts each after what it depends on. */
export function dependencyOrder(
  services: Readonly<Record<string, ComposeService>>
): Array<string> {
  const order: Array<string> = []
  const state = new Map<string, "done" | "visiting">()
  // The services being visited, each with its dependencies left.
  const trail: Array<{ readonly name: string; readonly left: Array<string> }> =
    []
  const enter = (name: string) => {
    state.set(name, "visiting")
    trail.push({
      left: Object.keys(services[name]?.depends_on ?? {})
        .sort()
        .reverse(),
      name,
    })
  }
  for (const start of Object.keys(services).sort()) {
    if (state.has(start)) continue
    enter(start)
    while (trail.length > 0) {
      const top = trail.at(-1)!
      const dependency = top.left.pop()
      if (dependency === undefined) {
        trail.pop()
        state.set(top.name, "done")
        order.push(top.name)
        continue
      }
      if (!services[dependency]) continue
      const current = state.get(dependency)
      if (current === "done") continue
      if (current === "visiting") {
        throw new ComposeError(
          `dependency cycle detected: ${[...trail.map((entry) => entry.name), dependency].join(" -> ")}`
        )
      }
      enter(dependency)
    }
  }
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
    `service "${name}" asks for a number of containers other than one, which Kiln doesn't support: each service runs one`
  )
}

function list(value: Value, at: string): Array<Value> {
  if (!Array.isArray(value)) throw new ComposeError(`${at} must be a list`)
  return value
}

function requiredString(value: Value, at: string): string {
  if (typeof value !== "string")
    throw new ComposeError(`${at} must be a string`)
  return value
}

function optionalString(value: Value, at: string): string | undefined {
  return value === undefined || value === null
    ? undefined
    : requiredString(value, at)
}

// Numbers and booleans in string positions are their YAML text.
function scalarString(value: Value, at: string): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  throw new ComposeError(`${at} must be a string`)
}

function stringList(value: Value, at: string): Array<string> {
  return list(value, at).map((entry) => scalarString(entry, at))
}

function stringMap(value: Value, at: string): Record<string, string> {
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
  if (typeof value === "string" && /^(?:true|false)$/iu.test(value)) {
    return value.toLowerCase() === "true"
  }
  throw new ComposeError(`${at} must be true or false`)
}

function integer(value: Value, at: string): number {
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new ComposeError(`${at} must be a whole number`)
  }
  return number
}

function externalFlag(value: Value, at: string): boolean {
  if (value === undefined || value === null) return false
  if (isMapping(value)) return true
  return bool(value, `${at}.external`)
}

// The deprecated `external: { name: … }` form.
function externalName(value: Value): string | undefined {
  return isMapping(value) && typeof value.name === "string"
    ? value.name
    : undefined
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path
}

/** Go durations, such as `1m30s`, in nanoseconds; a bare number is seconds. */
function duration(value: Value, at: string): number {
  if (typeof value === "number") return safe(Math.round(value * 1e9), at)
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
  return safe(Math.round(total), at)
}

/** Sizes as Compose reads them: bytes, or a number with a binary unit. */
function bytes(value: Value, at: string): number {
  // A number is taken as is, as compose-go takes it: -1 is unlimited.
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ComposeError(`${at} is out of range`)
    }
    return value
  }
  const match = /^(\d+(?:\.\d+)?)\s*([bkmgtp])?(?:i?b)?$/iu.exec(
    requiredString(value, at).trim()
  )
  if (!match)
    throw new ComposeError(`${at} has an invalid size "${String(value)}"`)
  const exponent = "bkmgtp".indexOf((match[2] ?? "b").toLowerCase())
  return safe(Math.trunc(Number(match[1]) * 1024 ** exponent), at)
}

// Nano CPUs, truncated as Compose converts them.
function nanoCpus(value: Value, at: string): number {
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    throw new ComposeError(`${at} must be a number of CPUs`)
  }
  return safe(Math.trunc(number * 1e9), at)
}

// Docker takes these as 64-bit integers; past 2^53 a number can't be sent
// exactly, and no real setting is that large.
function safe(number: number, at: string): number {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ComposeError(`${at} is out of range`)
  }
  return number
}
