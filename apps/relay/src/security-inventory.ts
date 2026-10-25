import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  access,
  constants,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { availableParallelism, hostname, loadavg } from "node:os"
import { dirname, extname, join, relative } from "node:path"
import { promisify } from "node:util"
import {
  relaySecurityInventoryChunkBytes,
  relaySecurityInventoryMaxBytes,
  securityImageIdSchema,
  type RelaySecurityContainer,
  type RelaySecurityInventoryRequest,
  type RelaySecurityInventoryResponse,
  type RelaySecurityTarget,
  type RelaySecurityTargets,
} from "@workspace/contracts"
import { Effect, Semaphore } from "effect"

import type { RelayConfig } from "./config.js"
import {
  containerName,
  DockerEngine,
  type DockerContainerInspect,
} from "./docker-engine.js"
import { promiseEffect, recoverPromise } from "./effect/promise.js"
import { PLATFORM_ROLE_LABEL } from "./platform.js"
import {
  relayOwnerLabels,
  relayOwnsLabels,
  relayResourceNames,
} from "./relay-resources.js"

// Inventories the software on the Relay's host and in the images its
// containers run, with Syft, for Hearth to check against known
// vulnerabilities. An image's inventory never changes, so Hearth asks for
// each image once; the host's changes with its packages, so Hearth asks for
// it again now and then.
//
// Syft runs in a short-lived helper from the Relay's own image, never in the
// Relay or a workload's container, with the least CPU weight Docker gives,
// at most one core, a memory cap, and the first claim on being killed when
// the host runs short. One inventory runs at a time, and none starts while
// the host is busy: the Relay answers `busy` and Hearth asks again later.
//
// Images are read through Docker, which exports them to Syft without
// starting them. The host is read through only its package databases and OS
// release file, each mounted read-only, so the helper never walks the
// host's filesystem.

const HELPER_LABEL = "io.kiln.security-helper"
const HOST_ROOT = "/kiln-host"
// What Syft's OS catalogers read, for Debian and Ubuntu, Red Hat's family,
// SUSE, Alpine, and Arch. A symlink is mounted from where it leads.
const HOST_PATHS = [
  "/etc/os-release",
  "/usr/lib/os-release",
  "/var/lib/dpkg/status",
  "/var/lib/dpkg/status.d",
  "/var/lib/rpm",
  "/usr/lib/sysimage/rpm",
  "/usr/share/rpm",
  "/lib/apk/db",
  "/var/lib/pacman/local",
] as const
const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024
// Node's share of it, slimming Syft's output once Syft has exited.
const HELPER_HEAP_MEGABYTES = 768
const SCAN_TIMEOUT_MS = 10 * 60_000
// Inventories Hearth hasn't come back for are removed after a day.
const CACHE_MAX_AGE_MS = 24 * 60 * 60_000

const run = promisify(execFile)

type SecurityInventoryConfig = Pick<
  RelayConfig,
  | "dataDirectory"
  | "dockerSocket"
  | "mode"
  | "nodeName"
  | "resourceNamespace"
  | "selfContainer"
  | "serverIdLabel"
  | "syftPath"
>

interface InventoryMeta {
  readonly collectedAt: number
  readonly generator: string
  readonly key: string
  readonly sha256: string
  readonly size: number
}

interface InventoryPaths {
  readonly document: string
  readonly key: string
  readonly meta: string
}

interface ContainerInspect extends DockerContainerInspect {
  readonly Image: string
}

export class SecurityInventory {
  readonly #config: SecurityInventoryConfig
  readonly #directory: string
  readonly #engine: DockerEngine
  // One inventory at a time; requests for others wait their turn.
  readonly #permit = Semaphore.makeUnsafe(1)
  #scanner: Promise<string | null> | null = null

  constructor(config: SecurityInventoryConfig) {
    this.#config = config
    this.#directory = join(config.dataDirectory, "security")
    this.#engine = new DockerEngine(config.dockerSocket)
  }

  /** The host, and every container on it that's Kiln's, with its image. */
  async targets(): Promise<RelaySecurityTargets> {
    const [listed, info, scanner] = await Promise.all([
      Effect.runPromise(this.#engine.listContainers({ all: true })),
      recoverPromise(
        () => Effect.runPromise(this.#engine.info({ timeout: 10_000 })),
        () => null
      ),
      this.#scannerVersion(),
    ])
    const containers: Array<RelaySecurityContainer> = []
    for (const container of listed) {
      const imageId = securityImageIdSchema.safeParse(container.ImageID)
      if (!imageId.success) continue
      const owner = this.#owner(containerName(container), container)
      if (!owner) continue
      containers.push({
        ...owner,
        image: container.Image,
        imageId: imageId.data,
        running: container.State === "running",
      })
    }
    return {
      containers,
      host: {
        architecture: info?.Architecture || null,
        docker: info?.ServerVersion || null,
        kernel: info?.KernelVersion || null,
        os: info?.OperatingSystem || null,
      },
      scanner,
    }
  }

  /** Reads a target's inventory, collecting it first when it's too old. */
  async inventory(
    input: RelaySecurityInventoryRequest
  ): Promise<RelaySecurityInventoryResponse> {
    const paths = this.#paths(input.target)
    let meta = await this.#meta(paths.meta)
    const stale =
      meta === null ||
      (input.collectedAfter !== null &&
        meta.collectedAt <= input.collectedAfter)
    if (input.offset === 0 && stale) {
      if (busy()) return { status: "busy" }
      const collected = await recoverPromise(
        () =>
          this.#enqueue(() =>
            this.#collect(input.target, paths, input.collectedAfter)
          ),
        (cause) => ({
          error: (cause instanceof Error ? cause.message : String(cause)).slice(
            0,
            1_000
          ),
          status: "failed" as const,
        })
      )
      if (collected.status !== "ready") return collected
      meta = collected.meta
    }
    if (meta === null) {
      return {
        error: "The Relay no longer has this inventory; ask for it again",
        status: "failed",
      }
    }
    const length = Math.max(
      0,
      Math.min(relaySecurityInventoryChunkBytes, meta.size - input.offset)
    )
    const chunk = Buffer.alloc(length)
    await Effect.runPromise(
      Effect.acquireUseRelease(
        promiseEffect(() => open(paths.document, "r")),
        (file) =>
          promiseEffect(() => file.read(chunk, 0, length, input.offset)),
        (file) => Effect.promise(() => file.close())
      )
    )
    return {
      collectedAt: meta.collectedAt,
      data: chunk.toString("base64"),
      generator: meta.generator,
      offset: input.offset,
      sha256: meta.sha256,
      size: meta.size,
      status: "ready",
    }
  }

  // Who a container belongs to: the Relay, for itself and Kiln's services
  // beside it, or the game server, database, or app it runs. Others' are
  // left out.
  #owner(
    name: string,
    container: {
      readonly Id: string
      readonly Labels: Readonly<Record<string, string>> | null
    }
  ): Pick<RelaySecurityContainer, "component" | "resource"> | null {
    const relay = (component: string) => ({
      component,
      resource: { id: "relay", type: "relay" as const },
    })
    const self = this.#config.selfContainer ?? hostname()
    if (name === self || container.Id.startsWith(self)) return relay("Relay")
    const labels = container.Labels ?? {}
    if (!relayOwnsLabels(this.#config, labels)) return null
    const appId = labels["kiln.app.id"]
    if (appId) {
      return {
        component: labels["kiln.app.service"] ?? null,
        resource: { id: appId, type: "app" },
      }
    }
    const databaseId = labels["kiln.database.id"]
    if (databaseId) {
      return { component: null, resource: { id: databaseId, type: "database" } }
    }
    const serverId = labels[this.#config.serverIdLabel]
    if (serverId && labels["kiln.relay.managed"] === "true") {
      return {
        component: null,
        resource: { id: serverId.toLowerCase(), type: "instance" },
      }
    }
    const names = relayResourceNames(this.#config)
    const service = new Map([
      [names.traefikContainer, "Traefik"],
      [names.coreDnsContainer, "CoreDNS"],
      [names.tailscaleContainer, "Tailscale"],
      [names.limboContainer, "Limbo"],
    ]).get(name)
    if (service) return relay(service)
    const role = labels[PLATFORM_ROLE_LABEL]
    if (this.#config.mode === "platform" && role) {
      const platform = { cache: "Valkey", database: "MySQL", hearth: "Hearth" }
      const component = platform[role as keyof typeof platform]
      if (component) return relay(component)
    }
    return null
  }

  #paths(target: RelaySecurityTarget): InventoryPaths {
    const key = target.kind === "host" ? "host" : target.imageId
    const name = createHash("sha256").update(key).digest("hex").slice(0, 32)
    return {
      document: join(this.#directory, `${name}.json.gz`),
      key,
      meta: join(this.#directory, `${name}.json`),
    }
  }

  async #meta(path: string): Promise<InventoryMeta | null> {
    return recoverPromise(
      async () => JSON.parse(await readFile(path, "utf8")) as InventoryMeta,
      () => null
    )
  }

  #enqueue<A>(work: () => Promise<A>): Promise<A> {
    return Effect.runPromise(this.#permit.withPermit(promiseEffect(work)))
  }

  // The Syft build this Relay runs, or null without one.
  #scannerVersion(): Promise<string | null> {
    this.#scanner ??= recoverPromise(
      async () => {
        await access(this.#config.syftPath, constants.X_OK)
        const { stdout } = await run(
          this.#config.syftPath,
          ["version", "-o", "json"],
          { env: { SYFT_CHECK_FOR_APP_UPDATE: "false" }, timeout: 10_000 }
        )
        const version = (JSON.parse(stdout) as { version?: string }).version
        return version ? `syft ${version}` : null
      },
      () => null
    ).then((version) => {
      // Without one, look again next time, as after it's installed.
      if (version === null) this.#scanner = null
      return version
    })
    return this.#scanner
  }

  async #collect(
    target: RelaySecurityTarget,
    paths: InventoryPaths,
    collectedAfter: number | null
  ): Promise<
    | { readonly meta: InventoryMeta; readonly status: "ready" }
    | Exclude<RelaySecurityInventoryResponse, { status: "ready" }>
  > {
    // A request that waited its turn may find another collected it.
    const existing = await this.#meta(paths.meta)
    if (
      existing &&
      (collectedAfter === null || existing.collectedAt > collectedAfter)
    ) {
      return { meta: existing, status: "ready" }
    }
    const generator = await this.#scannerVersion()
    if (generator === null) {
      return {
        error: "Update this Relay to inventory its software",
        status: "failed",
      }
    }
    await mkdir(this.#directory, { recursive: true })
    await this.#prune()
    const relay = await Effect.runPromise(
      this.#engine.inspectContainer<ContainerInspect>(
        this.#config.selfContainer ?? hostname()
      )
    )
    const mounted = (relay.Mounts ?? []).some((mount) => {
      const inside = relative(mount.Destination, this.#directory)
      return !inside.startsWith("..") && !inside.startsWith("/")
    })
    if (!mounted) {
      return {
        error: "Mount the Relay's data directory as a volume to inventory it",
        status: "failed",
      }
    }
    const securityOptions = await this.#securityOptions()
    const output = join(this.#directory, `scan-${randomUUID()}.json.gz`)
    const source =
      target.kind === "host"
        ? await this.#hostMounts(relay, securityOptions)
        : null
    const helperName = this.#helperName("scan")
    // The helper and what it wrote go, however the scan ends: the helper
    // first, so it can't write again after its files are removed.
    const cleanup = this.#engine
      .removeContainer(helperName, { force: true })
      .pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.promise(() =>
            Promise.all([
              rm(output, { force: true }),
              rm(`${output}.syft.json`, { force: true }),
            ])
          )
        )
      )
    // Beside the Relay's own entry, which is TypeScript in development.
    const main = process.argv[1] ?? ""
    const development = extname(main) === ".ts"
    const entry = join(
      dirname(main),
      `security-inventory-helper${extname(main)}`
    )
    const scan = async (): Promise<
      | { readonly meta: InventoryMeta; readonly status: "ready" }
      | Exclude<RelaySecurityInventoryResponse, { status: "ready" }>
    > => {
      const helper = await Effect.runPromise(
        this.#engine.createContainer(helperName, {
          Image: relay.Image,
          // Node from the Relay's own image runs Syft, then slims its
          // output, both within the helper's caps.
          Entrypoint: [process.execPath],
          Cmd: [
            ...(development ? ["--import", "tsx"] : []),
            `--max-old-space-size=${HELPER_HEAP_MEGABYTES}`,
            entry,
            "scan",
            target.kind === "host"
              ? `dir:${HOST_ROOT}`
              : `docker:${target.imageId}`,
            ...(target.kind === "host"
              ? ["--override-default-catalogers", "os"]
              : []),
            "--source-name",
            target.kind === "host"
              ? this.#config.nodeName || "host"
              : target.image || target.imageId,
          ],
          WorkingDir: process.cwd(),
          Env: [
            "SYFT_CHECK_FOR_APP_UPDATE=false",
            // Packages, not every file's digest.
            "SYFT_FILE_METADATA_SELECTION=none",
            `DOCKER_HOST=unix://${this.#config.dockerSocket}`,
            `KILN_SECURITY_HOST=${target.kind === "host" ? "1" : ""}`,
            `KILN_SECURITY_MAX_BYTES=${relaySecurityInventoryMaxBytes}`,
            `KILN_SECURITY_OUTPUT=${output}`,
            `KILN_SECURITY_SYFT=${this.#config.syftPath}`,
          ],
          Healthcheck: { Test: ["NONE"] },
          Labels: { [HELPER_LABEL]: "true", ...relayOwnerLabels(this.#config) },
          HostConfig: {
            AutoRemove: false,
            BlkioWeight: 10,
            CpuShares: 2,
            Memory: HELPER_MEMORY_BYTES,
            MemorySwap: HELPER_MEMORY_BYTES,
            Mounts: source ?? [],
            NanoCpus: 1_000_000_000,
            NetworkMode: "none",
            OomScoreAdj: 1000,
            PidsLimit: 512,
            SecurityOpt: [
              "no-new-privileges",
              // SELinux would keep the helper from reading host files.
              ...(source && securityOptions.has("selinux")
                ? ["label=disable"]
                : []),
            ],
            VolumesFrom: [relay.Id],
          },
        })
      )
      await Effect.runPromise(this.#engine.startContainer(helper.Id))
      const exitCode = await Effect.runPromise(
        this.#engine.waitContainer(helper.Id, "not-running").pipe(
          Effect.timeoutOrElse({
            duration: SCAN_TIMEOUT_MS,
            orElse: () => Effect.succeed(null),
          })
        )
      )
      if (exitCode !== 0) {
        return {
          error: await this.#failure(helper.Id, exitCode),
          status: "failed",
        }
      }
      // Never more than the helper may write, so it's read whole.
      if ((await stat(output)).size > relaySecurityInventoryMaxBytes) {
        return { error: "The inventory is too large to send", status: "failed" }
      }
      const gzipped = await readFile(output)
      const meta: InventoryMeta = {
        collectedAt: Date.now(),
        generator,
        key: paths.key,
        sha256: createHash("sha256").update(gzipped).digest("hex"),
        size: gzipped.length,
      }
      await rename(output, paths.document)
      await writeFile(paths.meta, `${JSON.stringify(meta)}\n`)
      return { meta, status: "ready" }
    }
    return Effect.runPromise(promiseEffect(scan).pipe(Effect.ensuring(cleanup)))
  }

  // Each host path the OS catalogers read that exists, mounted read-only
  // where Syft looks for it. A created helper that never starts tells
  // whether each exists and where its symlinks lead, so nothing missing is
  // mounted and nothing is created on the host.
  async #hostMounts(
    relay: ContainerInspect,
    securityOptions: ReadonlySet<string>
  ): Promise<Array<unknown>> {
    const probeName = this.#helperName("probe")
    await Effect.runPromise(
      this.#engine.createContainer(probeName, {
        Image: relay.Image,
        Entrypoint: [this.#config.syftPath],
        Labels: { [HELPER_LABEL]: "true", ...relayOwnerLabels(this.#config) },
        HostConfig: {
          Mounts: [
            {
              BindOptions: { NonRecursive: true },
              ReadOnly: true,
              Source: "/",
              Target: HOST_ROOT,
              Type: "bind",
            },
          ],
          NetworkMode: "none",
          ...(securityOptions.has("selinux") && {
            SecurityOpt: ["label=disable"],
          }),
        },
      })
    )
    const probe = async () => {
      const sources = new Map<string, string>()
      for (const path of HOST_PATHS) {
        const target = await Effect.runPromise(
          this.#engine.containerPathTarget(probeName, `${HOST_ROOT}${path}`)
        )
        if (target === null || !target.startsWith(`${HOST_ROOT}/`)) continue
        const source = target.slice(HOST_ROOT.length)
        // Mounted once, so a symlinked package database isn't read twice.
        if (!sources.has(source)) sources.set(source, path)
      }
      if (![...sources.values()].some((path) => !path.includes("os-release"))) {
        throw new Error("Kiln can't read this host's package manager")
      }
      return [...sources].map(([source, path]) => ({
        ReadOnly: true,
        Source: source,
        Target: `${HOST_ROOT}${path}`,
        Type: "bind",
      }))
    }
    return Effect.runPromise(
      promiseEffect(probe).pipe(
        Effect.ensuring(
          this.#engine
            .removeContainer(probeName, { force: true })
            .pipe(Effect.catch(() => Effect.void))
        )
      )
    )
  }

  #helperName(kind: string): string {
    const name = `kiln-security-${kind}-${randomUUID().slice(0, 8)}`
    return this.#config.resourceNamespace
      ? `${this.#config.resourceNamespace}-${name}`
      : name
  }

  async #failure(id: string, exitCode: number | null): Promise<string> {
    if (exitCode === null) return "The inventory took longer than 10 minutes"
    const inspect = await recoverPromise(
      () => Effect.runPromise(this.#engine.inspectContainer(id)),
      () => null
    )
    if (inspect?.State.OOMKilled) return "The inventory ran out of memory"
    const logs = await recoverPromise(
      () =>
        Effect.runPromise(
          this.#engine.containerLogs(id, { tail: 20, tty: false })
        ),
      () => null
    )
    const detail = (logs?.stderr || logs?.stdout || "").trim().slice(-500)
    return detail || `Syft exited with code ${exitCode}`
  }

  // Inventories nothing has asked for in a day, scans a stopped Relay left
  // behind, and helpers it didn't remove.
  async #prune(): Promise<void> {
    const now = Date.now()
    for (const entry of await readdir(this.#directory)) {
      const path = join(this.#directory, entry)
      const modified = await recoverPromise(
        async () => (await stat(path)).mtimeMs,
        () => now
      )
      if (now - modified > CACHE_MAX_AGE_MS || entry.startsWith("scan-")) {
        await rm(path, { force: true })
      }
    }
    const helpers = await Effect.runPromise(
      this.#engine.listContainers({
        all: true,
        filters: { label: [`${HELPER_LABEL}=true`] },
      })
    )
    for (const helper of helpers) {
      if (!relayOwnsLabels(this.#config, helper.Labels)) continue
      await Effect.runPromise(
        this.#engine
          .removeContainer(helper.Id, { force: true })
          .pipe(Effect.catch(() => Effect.void))
      )
    }
  }

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
}

// As provisioning judges it: a load average of one per core or more.
function busy(): boolean {
  return (loadavg()[0] ?? 0) / availableParallelism() >= 1
}
