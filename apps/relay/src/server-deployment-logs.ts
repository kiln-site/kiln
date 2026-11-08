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

import {
  relayServerDeploymentLogSchema,
  type ProvisioningWorkPhase,
  type RelayConsoleLine,
  type RelayServerDeploymentLog,
} from "@workspace/contracts"

import { forkPromise, promiseEffect, recoverPromise } from "./effect/promise.js"
import { physicalKey } from "./instance-keys.js"
import { provisioningErrorMessage } from "./provisioning-errors.js"
import { provisioningStatus } from "./provisioning.js"

// A game server's deployments, as Hearth records them: its first install,
// each reinstall, and each change of Brick. Hearth names each one; the
// Relay logs the steps it took and how it ended under that ID, in
// `<data>/server-deployments/<server>/<deployment>.json`, keeping each
// server's 20 latest. A log is rewritten whole as it grows, which its few
// lines make cheap.

const keptPerServer = 20
const maxLines = 500

type Log = NonNullable<RelayServerDeploymentLog>

export class ServerDeploymentLogs {
  readonly #directory: string
  // Installs Hearth named as it claimed their provisioning, until the job
  // runs. A restart fails the job, so nothing here needs to outlive one.
  readonly #pendingInstalls = new Map<string, string>()

  constructor(dataDirectory: string) {
    this.#directory = join(dataDirectory, "server-deployments")
  }

  /** Notes the deployment a claimed install logs under. */
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
      instanceId,
      deploymentId,
      "Installing the game server",
      work
    )
  }

  /**
   * Runs `work` as a deployment's, logging each phase it reports and how
   * it ends. Without a deployment ID it only runs.
   */
  async run<T>(
    instanceId: string,
    deploymentId: string | undefined,
    title: string,
    work: (
      onPhase: (phase: ProvisioningWorkPhase) => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    if (!deploymentId) return work(async () => undefined)
    // A log that can't be started leaves the deployment to run unlogged.
    const log = await recoverPromise(
      () => this.#start(instanceId, deploymentId, title),
      () => null
    )
    if (!log) return work(async () => undefined)
    return Effect.runPromise(
      promiseEffect(() =>
        work((phase) => log.line(provisioningStatus(phase, "game server")))
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

  /** A deployment's log, or null when the Relay doesn't keep it. */
  async read(
    instanceId: string,
    deploymentId: string
  ): Promise<RelayServerDeploymentLog> {
    return readLog(this.#file(instanceId, deploymentId))
  }

  /** Forgets a deleted game server's logs. */
  async remove(instanceId: string): Promise<void> {
    this.#pendingInstalls.delete(instanceId)
    await rm(this.#serverDirectory(instanceId), {
      force: true,
      recursive: true,
    })
  }

  async #start(instanceId: string, deploymentId: string, title: string) {
    const directory = this.#serverDirectory(instanceId)
    await mkdir(directory, { recursive: true })
    await this.#prune(directory)
    const log = new ServerDeploymentLog(
      this.#file(instanceId, deploymentId),
      deploymentId
    )
    await log.line(title)
    return log
  }

  // Keeps room for one more among the server's latest.
  async #prune(directory: string) {
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json")
    )
    if (names.length < keptPerServer) return
    const dated = await Promise.all(
      names.map(async (name) => {
        const startedAt = (await readLog(join(directory, name)))?.deployment
          .startedAt
        return { name, startedAt: startedAt ? Date.parse(startedAt) : 0 }
      })
    )
    dated.sort((left, right) => right.startedAt - left.startedAt)
    await Promise.all(
      dated
        .slice(keptPerServer - 1)
        .map(({ name }) => rm(join(directory, name), { force: true }))
    )
  }

  #serverDirectory(instanceId: string) {
    return join(this.#directory, physicalKey(instanceId))
  }

  #file(instanceId: string, deploymentId: string) {
    return join(this.#serverDirectory(instanceId), `${deploymentId}.json`)
  }
}

// A log as saved, or null when it's missing or unreadable.
function readLog(file: string): Promise<RelayServerDeploymentLog> {
  return recoverPromise(
    async () =>
      relayServerDeploymentLogSchema.safeParse(
        JSON.parse(await readFile(file, "utf8")) as unknown
      ).data ?? null,
    () => null
  )
}

class ServerDeploymentLog {
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
        startedAt: new Date().toISOString(),
        state: "running",
      },
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
    const temporary = `${this.#file}.${randomUUID()}.tmp`
    this.#writing = this.#writing.then(() =>
      recoverPromise(
        async () => {
          await writeFile(temporary, content, "utf8")
          await rename(temporary, this.#file)
        },
        () => forkPromise(() => rm(temporary, { force: true }))
      )
    )
    return this.#writing
  }
}
