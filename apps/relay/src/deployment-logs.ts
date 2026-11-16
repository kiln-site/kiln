import { randomUUID } from "node:crypto"
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"
import type { z } from "zod"

import {
  relayDeploymentIdSchema,
  relayDeploymentLogSchema,
  type ProvisioningWorkPhase,
  type RelayConsoleLine,
  type RelayDeploymentLog,
} from "@workspace/contracts"

import { forkPromise, promiseEffect, recoverPromise } from "./effect/promise.js"
import { physicalKey } from "./instance-keys.js"
import { provisioningErrorMessage } from "./provisioning-errors.js"
import { provisioningStatus } from "./provisioning.js"

// Every instance's deployment logs, whatever its kind: a game server's
// install, each redeploy and each change of Brick, a database's redeploys,
// and an App's deployments. Each is saved whole as one file,
// `<data>/<folder>/<instance>/<deployment>.json`, in its kind's folder, so
// a log is only ever read as the kind it was written for. Each instance
// keeps its 20 latest.
//
// Hearth names a game server's and a database's deployments, and the Relay
// logs the steps it took under that name as it goes, rewriting the file
// whole as it grows, which its few lines make cheap. An App's deployment
// is named by the Relay, which follows its output live in memory (see
// `apps.ts`) and saves it here once it ends.

export type DeploymentLogKind = "app" | "database" | "instance" | "tunnel"

/** The instance whose deployments a log is one of. */
export interface DeploymentLogTarget {
  readonly id: string
  readonly kind: DeploymentLogKind
}

const folders: Record<DeploymentLogKind, string> = {
  app: "app-deployments",
  database: "database-deployments",
  instance: "server-deployments",
  tunnel: "tunnel-deployments",
}

const keptPerInstance = 20
const maxLines = 500

type Log = NonNullable<RelayDeploymentLog>

export class DeploymentLogs {
  readonly #dataDirectory: string
  // Installs Hearth named as it claimed their provisioning, until the job
  // runs. A restart fails the job, so nothing here needs to outlive one.
  readonly #pendingInstalls = new Map<string, string>()

  constructor(dataDirectory: string) {
    this.#dataDirectory = dataDirectory
  }

  /** Notes the deployment a claimed game server install logs under. */
  expectInstall(instanceId: string, deploymentId: string): void {
    if (!this.#pendingInstalls.has(instanceId)) {
      this.#pendingInstalls.set(instanceId, deploymentId)
    }
  }

  /** Runs a claimed install, logging it if Hearth named its deployment. */
  install<T>(
    instanceId: string,
    work: (
      onPhase: (phase: ProvisioningWorkPhase) => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    const deploymentId = this.#pendingInstalls.get(instanceId)
    this.#pendingInstalls.delete(instanceId)
    return this.run(
      { id: instanceId, kind: "instance" },
      deploymentId,
      "Installing the game server",
      work
    )
  }

  /**
   * Runs `work` as a deployment Hearth named, logging each phase it reports
   * and how it ends. Without a deployment ID it only runs.
   */
  async run<T>(
    target: DeploymentLogTarget,
    deploymentId: string | undefined,
    title: string,
    work: (
      onPhase: (phase: ProvisioningWorkPhase) => Promise<void>,
      /** A line of its own in the log. */
      note: (text: string) => Promise<void>
    ) => Promise<T>,
    /** What its phases name. */
    noun = "game server"
  ): Promise<T> {
    const unlogged = async () => undefined
    if (!deploymentId) return work(unlogged, unlogged)
    // A log that can't be started leaves the deployment to run unlogged.
    const log = await recoverPromise(
      () => this.#start(target, deploymentId, title),
      () => null
    )
    if (!log) return work(unlogged, unlogged)
    return Effect.runPromise(
      promiseEffect(() =>
        work(
          (phase) => log.line(provisioningStatus(phase, noun)),
          (text) => log.line(text)
        )
      ).pipe(
        Effect.tap(() => promiseEffect(() => log.finish(null))),
        Effect.tapError((error) =>
          promiseEffect(() => log.finish(provisioningErrorMessage(error))).pipe(
            Effect.ignore
          )
        )
      )
    )
  }

  /**
   * A deployment's saved log, read as `schema`, or null when the Relay
   * doesn't keep it.
   */
  read(
    target: DeploymentLogTarget,
    deploymentId: string
  ): Promise<RelayDeploymentLog>
  read<S extends z.ZodType>(
    target: DeploymentLogTarget,
    deploymentId: string,
    schema: S
  ): Promise<z.infer<S> | null>
  read(
    target: DeploymentLogTarget,
    deploymentId: string,
    schema: z.ZodType = relayDeploymentLogSchema
  ): Promise<unknown> {
    // Its ID names its file, so one that could name another is never kept.
    if (!relayDeploymentIdSchema.safeParse(deploymentId).success) {
      return Promise.resolve(null)
    }
    return readLog(this.#file(target, deploymentId), schema)
  }

  /** The newest of an instance's saved logs, read as `schema`, if any. */
  async latest<S extends z.ZodType>(
    target: DeploymentLogTarget,
    schema: S
  ): Promise<z.infer<S> | null> {
    const [newest] = await this.#dated(this.#directory(target))
    return newest
      ? readLog(join(this.#directory(target), newest.name), schema)
      : null
  }

  /**
   * Saves a deployment's log whole, keeping its instance's latest. One that
   * can't be saved only costs its history.
   */
  async save(target: DeploymentLogTarget, log: Log): Promise<void> {
    await recoverPromise(
      async () => {
        const directory = this.#directory(target)
        await mkdir(directory, { mode: 0o700, recursive: true })
        await writeAtomic(
          this.#file(target, log.deployment.id),
          JSON.stringify(log)
        )
        await this.#prune(directory, keptPerInstance)
      },
      () => undefined
    )
  }

  /** Forgets a deleted instance's logs. */
  async remove(target: DeploymentLogTarget): Promise<void> {
    if (target.kind === "instance") this.#pendingInstalls.delete(target.id)
    await rm(this.#directory(target), { force: true, recursive: true })
  }

  async #start(
    target: DeploymentLogTarget,
    deploymentId: string,
    title: string
  ) {
    const directory = this.#directory(target)
    await mkdir(directory, { mode: 0o700, recursive: true })
    // Keeps room for this one among the instance's latest.
    await this.#prune(directory, keptPerInstance - 1)
    const log = new RunningDeploymentLog(
      this.#file(target, deploymentId),
      deploymentId
    )
    await log.line(title)
    return log
  }

  async #prune(directory: string, keep: number) {
    const dated = await this.#dated(directory)
    await Promise.all(
      dated
        .slice(keep)
        .map(({ name }) => rm(join(directory, name), { force: true }))
    )
  }

  // An instance's saved logs, newest first.
  async #dated(directory: string) {
    const names = await recoverPromise(
      async () =>
        (await readdir(directory)).filter((name) => name.endsWith(".json")),
      (): Array<string> => []
    )
    const dated = await Promise.all(
      names.map(async (name) => {
        const startedAt = (
          await readLog(join(directory, name), relayDeploymentLogSchema)
        )?.deployment.startedAt
        return { name, startedAt: startedAt ? Date.parse(startedAt) : 0 }
      })
    )
    return dated.sort((left, right) => right.startedAt - left.startedAt)
  }

  #directory(target: DeploymentLogTarget) {
    return join(
      this.#dataDirectory,
      folders[target.kind],
      physicalKey(target.id)
    )
  }

  #file(target: DeploymentLogTarget, deploymentId: string) {
    return join(this.#directory(target), `${deploymentId}.json`)
  }
}

// A log as saved, or null when it's missing or unreadable.
function readLog<S extends z.ZodType>(
  file: string,
  schema: S
): Promise<z.infer<S> | null> {
  return recoverPromise(
    async () =>
      schema.safeParse(
        savedLog(JSON.parse(await readFile(file, "utf8")) as unknown)
      ).data ?? null,
    () => null
  )
}

// Logs saved before every kind shared one format: an App's held its
// deployment's fields beside its lines, and may predate recording whether
// it rolled over; a game server's or a database's had no dropped lines or
// rolling over to record.
function savedLog(saved: unknown): unknown {
  if (!isRecord(saved)) return saved
  const nested = "deployment" in saved ? saved : flatLog(saved)
  return isRecord(nested.deployment)
    ? {
        ...nested,
        deployment: { rolling: null, ...nested.deployment },
        dropped: nested.dropped ?? 0,
      }
    : nested
}

function flatLog({ dropped, lines, ...deployment }: Record<string, unknown>) {
  return { deployment, dropped, lines }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function writeAtomic(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await recoverPromise(
    async () => {
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, file)
    },
    (error) => {
      forkPromise(() => rm(temporary, { force: true }))
      throw error
    }
  )
}

// A deployment Hearth named, logged as it runs.
class RunningDeploymentLog {
  readonly #file: string
  readonly #log: Log
  // Writes in order, each the whole log as it stands.
  #writing: Promise<void> = Promise.resolve()

  constructor(file: string, deploymentId: string) {
    this.#file = file
    this.#log = {
      deployment: {
        error: null,
        finishedAt: null,
        id: deploymentId,
        rolling: null,
        startedAt: new Date().toISOString(),
        state: "running",
      },
      dropped: 0,
      lines: [],
    }
  }

  line(text: string, level: RelayConsoleLine["level"] = "info") {
    if (this.#log.lines.length < maxLines) {
      this.#log.lines.push(this.#entry(text, level))
    }
    return this.#save()
  }

  /** Ends it: succeeded without an error, failed with one. */
  async finish(error: string | null) {
    this.#log.lines.push(
      error ? this.#entry(error, "error") : this.#entry("Done", "info")
    )
    this.#log.deployment = {
      ...this.#log.deployment,
      error: error?.slice(0, 2_000) ?? null,
      finishedAt: new Date().toISOString(),
      state: error ? "failed" : "succeeded",
    }
    await this.#save()
  }

  #entry(text: string, level: RelayConsoleLine["level"]): RelayConsoleLine {
    return {
      id: String(this.#log.lines.length + 1),
      level,
      origin: "kiln",
      text,
      timestamp: new Date().toISOString(),
    }
  }

  // A log that can't be written leaves the deployment to run unlogged.
  #save() {
    const content = JSON.stringify(this.#log)
    this.#writing = this.#writing.then(() =>
      recoverPromise(
        () => writeAtomic(this.#file, content),
        () => undefined
      )
    )
    return this.#writing
  }
}
