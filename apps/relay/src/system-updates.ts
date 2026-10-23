import { randomUUID } from "node:crypto"
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"

import {
  compareKilnReleaseVersions,
  DEFAULT_KILN_GIT_REPO,
  isKilnGitRepositorySource,
  isKilnNightlyVersion,
  isKilnReleaseVersion,
  kilnReleaseVersionCore,
  kilnImageRepository,
  relaySystemUpdateSchema,
  type RelaySystemUpdate,
} from "@workspace/contracts"
import { Effect, Semaphore } from "effect"

import { runContainer } from "./docker-container-spec.js"
import { DockerEngine, isDockerNotFound } from "./docker-engine.js"
import { RelayNotFoundError, RelaySystemUpdateError } from "./effect/errors.js"
import {
  KILN_INSTALLATION_LABEL,
  kilnComponent,
  managedImageChannel,
  type KilnComponent,
} from "./update-container.js"

const STALE_UPDATE_MS = 10 * 60_000
const ORPHAN_LOCK_MS = 30_000

interface ContainerInspect {
  Config: {
    Hostname?: string
    Image: string
    Labels: Record<string, string | undefined> | null
  }
  Id: string
  Name: string
}

interface ImageInspect {
  Config?: {
    Labels?: Record<string, string | undefined> | null
  }
}

interface HelperInspect {
  State?: {
    Running?: boolean
  }
}

export interface UpdateOperation {
  batchId?: string
  component: KilnComponent
  error: string | null
  phase?: string
  finishedAt: string | null
  id: string
  // Labels a replacement whose container predates installation IDs.
  installationId?: string
  previousImage: string
  requestedImage: string
  // The Hearth request that started it, so a browser that lost the reply
  // can find it in the Relay's snapshot.
  requestId?: string
  startedAt: string
  status: "failed" | "running" | "succeeded"
  targetContainer: string
  targetReference?: string
  version: string
}

interface UpdateBatch {
  id: string
  operationIds: Array<string>
}

interface InstallationIdentity {
  readonly installationId?: string | null
  readonly installationIdConfigured?: boolean
}

interface SystemUpdateTargetInput {
  targetContainer: string
  targetImage: string
  version: string
}

export class SystemUpdateManager {
  readonly #batchSemaphore = Semaphore.makeUnsafe(1)
  // Read on each use: Hearth can give the Relay its installation ID at any
  // time after it starts.
  readonly #installation: InstallationIdentity
  readonly #gitRepository: string
  readonly #operationsDirectory: string
  readonly #engine: DockerEngine
  #activeBatch: { id: string } | null = null
  // The latest update of each component. Records on disk are merged in on
  // the first read.
  readonly #latest = new Map<KilnComponent, UpdateOperation>()
  #latestLoaded = false
  // Updates this process is still starting. Their helper isn't launched yet,
  // so `status` doesn't take its absence for a helper that stopped.
  readonly #starting = new Set<string>()

  // Why a container may not be updated now, such as a Hearth held stopped
  // for an offline restore; null when it may.
  readonly #refuseTarget: (container: string) => Effect.Effect<string | null>

  constructor(
    config: {
      dataDirectory: string
      dockerSocket?: string
      gitRepository?: string
      installationId?: string | null
      installationIdConfigured?: boolean
    },
    options: {
      refuseTarget?: (container: string) => Effect.Effect<string | null>
    } = {}
  ) {
    this.#refuseTarget = options.refuseTarget ?? (() => Effect.succeed(null))
    this.#engine = new DockerEngine(
      config.dockerSocket ?? "/var/run/docker.sock"
    )
    this.#gitRepository = config.gitRepository ?? DEFAULT_KILN_GIT_REPO
    this.#installation = config
    this.#operationsDirectory = join(config.dataDirectory, "updates")
  }

  /**
   * Inspects a container Hearth named, or this Relay's own when `container`
   * is null. Hearth asks every Relay for its own container and only the one
   * on its Docker host has it, so a named container that isn't here fails
   * with RelayNotFoundError rather than as a Relay error.
   */
  inspect(container: string | null) {
    return inspectContainerEffect(this.#engine, container ?? hostname()).pipe(
      Effect.catchIf(
        (cause) => container !== null && isContainerMissing(cause),
        () =>
          Effect.fail(
            RelayNotFoundError.make({
              message: `Container ${container} isn't on this Relay's Docker host`,
            })
          )
      ),
      Effect.map((inspected) =>
        updateEligibility(inspected, this.#installation, this.#gitRepository)
      ),
      Effect.withSpan("relay.systemUpdates.inspect")
    )
  }

  start(
    input: {
      helperImage: string
      targetContainer: string
      targetImage: string
      version: string
    },
    signal?: AbortSignal
  ) {
    return this.startBatch(
      {
        helperImage: input.helperImage,
        targets: [input],
      },
      signal
    ).pipe(
      Effect.flatMap((operations) =>
        operations[0]
          ? Effect.succeed(operations[0])
          : systemUpdateFailure("start.batch", "No update target was queued")
      )
    )
  }

  startBatch(
    input: {
      helperImage: string
      requestId?: string
      targets: ReadonlyArray<SystemUpdateTargetInput>
    },
    signal?: AbortSignal
  ) {
    const engine = this.#engine
    const installation = this.#installation
    const gitRepository = this.#gitRepository
    const operationsDirectory = this.#operationsDirectory
    const setActiveBatch = (id: string) => {
      this.#activeBatch = { id }
    }
    const starting = this.#starting
    return this.#batchSemaphore.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* ensureNotAbortedEffect(signal)
        if (
          releaseImageComponent(input.helperImage, gitRepository) !== "relay"
        ) {
          return yield* systemUpdateFailure(
            "start.validate",
            "The update helper must be a Relay digest from this distribution"
          )
        }
        if (input.targets.length === 0) {
          return yield* systemUpdateFailure(
            "start.validate",
            "Choose at least one update target"
          )
        }

        yield* systemUpdateOperation("start.createDirectory", () =>
          mkdir(operationsDirectory, { recursive: true, mode: 0o700 })
        )
        const activeBatch = yield* this.#runningBatchEffect()
        const batchId = activeBatch?.id ?? randomUUID()
        const startedAt = new Date().toISOString()
        const preparedTargets = yield* Effect.forEach(
          input.targets,
          (targetInput) =>
            prepareUpdateEffect(
              engine,
              targetInput,
              batchId,
              startedAt,
              installation,
              gitRepository,
              input.requestId
            ),
          { concurrency: "unbounded" }
        )
        for (const target of preparedTargets) {
          const refusal = yield* this.#refuseTarget(
            target.operation.targetContainer
          )
          if (refusal) {
            return yield* systemUpdateFailure("start.validate", refusal)
          }
        }
        const prepared = preparedTargets.sort((left, right) =>
          left.operation.component === right.operation.component
            ? 0
            : left.operation.component === "hearth"
              ? -1
              : 1
        )
        const operations = prepared.map(({ operation }) => operation)

        yield* acquireOperationLocksEffect(operationsDirectory, operations)
        for (const { id } of operations) starting.add(id)
        const failOperations = (cause: RelaySystemUpdateError) =>
          failQueuedOperationsEffect(
            operationsDirectory,
            operations,
            signal?.aborted
              ? "The update request was cancelled before replacement started."
              : cause.message
          )

        return yield* Effect.gen({ self: this }, function* () {
          // Again now the targets are locked: maintenance may have begun
          // since the check above, and it takes the same locks to hold Hearth.
          for (const operation of operations) {
            const refusal = yield* this.#refuseTarget(operation.targetContainer)
            if (refusal) {
              return yield* systemUpdateFailure("start.validate", refusal)
            }
          }
          // Recorded before the images are pulled, which can take minutes,
          // so a Relay restarted meanwhile still knows about them.
          yield* Effect.forEach(
            operations,
            (operation) => writeOperationEffect(operationsDirectory, operation),
            { discard: true }
          )
          this.#remember(operations)
          const images = uniqueUpdateImages(input.helperImage, prepared)
          const inspectedImages = yield* Effect.forEach(
            images,
            ({ component, image }) =>
              pullAndVerifyImageEffect(
                engine,
                image,
                component,
                gitRepository,
                signal
              ).pipe(Effect.map((inspected) => ({ image, inspected }))),
            { concurrency: "unbounded" }
          )
          for (const { input: targetInput, operation } of prepared) {
            const inspected = inspectedImages.find(
              ({ image }) => image === targetInput.targetImage
            )?.inspected
            const imageVersion =
              inspected?.Config?.Labels?.["org.opencontainers.image.version"]
            if (
              !imageVersionMatchesRelease(imageVersion, targetInput.version)
            ) {
              return yield* systemUpdateFailure(
                "start.verifyImage",
                `The ${operation.component} image version does not match the release`
              )
            }
          }

          const volumesFrom =
            prepared.find(({ operation }) => operation.component === "relay")
              ?.container ??
            (yield* inspectContainerEffect(engine, hostname()))
          const volumesFromLabels = volumesFrom.Config.Labels ?? {}
          if (
            kilnComponent(volumesFromLabels["io.kiln.component"]) !== "relay" ||
            !isKilnGitRepositorySource(
              volumesFromLabels["org.opencontainers.image.source"],
              gitRepository
            )
          ) {
            return yield* systemUpdateFailure(
              "start.verifyRelay",
              "Docker could not identify this Relay container"
            )
          }

          const batch: UpdateBatch = {
            id: batchId,
            operationIds: [
              ...(activeBatch?.operationIds ?? []),
              ...operations.map(({ id }) => id),
            ],
          }
          yield* writeBatchEffect(operationsDirectory, batch)
          yield* ensureNotAbortedEffect(signal)

          const helperState = activeBatch
            ? yield* helperStateEffect(engine, batchId)
            : "stopped"
          if (helperState !== "running") {
            yield* cleanupHelperEffect(engine, batchId)
            yield* launchBatchHelperEffect(
              engine,
              {
                batchId,
                helperImage: input.helperImage,
                operationsDirectory,
                volumesFrom: volumesFrom.Id,
              },
              signal
            )
          }
          setActiveBatch(batchId)
          return operations
        }).pipe(
          Effect.catch((cause) =>
            failOperations(cause).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  operations.map((operation): UpdateOperation => ({
                    ...operation,
                    error: signal?.aborted
                      ? "The update request was cancelled before replacement started."
                      : cause.message,
                    finishedAt: new Date().toISOString(),
                    status: "failed",
                  }))
                )
              ),
              Effect.tap((failed) => Effect.sync(() => this.#remember(failed))),
              Effect.flatMap((failed) =>
                signal?.aborted
                  ? systemUpdateFailure(
                      "start.cancelled",
                      abortReason(signal).message,
                      abortReason(signal)
                    )
                  : Effect.succeed(failed)
              )
            )
          ),
          Effect.onInterrupt(() =>
            failQueuedOperationsEffect(
              operationsDirectory,
              operations,
              "The update request was interrupted before replacement started."
            ).pipe(
              Effect.catch((cleanupCause) =>
                Effect.logWarning(
                  "System update interruption cleanup failed",
                  cleanupCause
                )
              )
            )
          ),
          Effect.ensuring(
            Effect.sync(() => {
              for (const { id } of operations) starting.delete(id)
            })
          )
        )
      }).pipe(Effect.withSpan("relay.systemUpdates.startBatch"))
    )
  }

  /**
   * The latest update of each component, for the Relay's snapshot. The
   * update helper records a running update's progress and outcome on disk,
   * so those are read again; this also notices updates that stopped without
   * an outcome (see `status`). What can't be read now is reported as last
   * known, and read again next time.
   */
  updates(): Effect.Effect<Array<RelaySystemUpdate>> {
    return Effect.gen({ self: this }, function* () {
      if (!this.#latestLoaded) {
        const recorded = yield* recordedOperationsEffect(
          this.#operationsDirectory
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#latestLoaded = true
            })
          ),
          Effect.catch((cause) =>
            Effect.logWarning(
              "System update records could not be read",
              cause
            ).pipe(Effect.as([]))
          )
        )
        this.#remember(recorded)
      }
      const running = Array.from(this.#latest.values()).filter(
        (operation) => operation.status === "running"
      )
      const current = yield* Effect.forEach(
        running,
        (operation) =>
          this.status(operation.id).pipe(
            Effect.catch(() => Effect.succeed(null))
          ),
        { concurrency: "unbounded" }
      )
      this.#remember(current.flatMap((operation) => operation ?? []))
      return Array.from(this.#latest.values()).flatMap(reportedUpdate)
    })
  }

  #remember(operations: ReadonlyArray<UpdateOperation>) {
    for (const operation of operations) {
      // One that can't be reported can't be compared with later ones either.
      if (reportedUpdate(operation).length === 0) continue
      const known = this.#latest.get(operation.component)
      if (!known || known.id === operation.id || isNewer(operation, known)) {
        this.#latest.set(operation.component, operation)
      }
    }
  }

  // Whether an update this Relay started is still running.
  running() {
    return this.#runningBatchEffect().pipe(
      Effect.map((batch) => batch !== null)
    )
  }

  #runningBatchEffect() {
    const active = this.#activeBatch
    if (!active) return Effect.succeed<UpdateBatch | null>(null)
    return helperStateEffect(this.#engine, active.id).pipe(
      Effect.flatMap((state) =>
        state === "running"
          ? readBatchEffect(this.#operationsDirectory, active.id)
          : Effect.sync(() => {
              this.#activeBatch = null
              return null
            })
      )
    )
  }

  status(id: string) {
    const engine = this.#engine
    const operationsDirectory = this.#operationsDirectory
    const starting = this.#starting
    return Effect.gen(function* () {
      if (!/^[0-9a-f-]{36}$/u.test(id)) return null
      const operation = yield* readOperationEffect(operationsDirectory, id)
      if (!operation) return null
      // Its helper isn't launched yet, so a missing helper means nothing.
      if (starting.has(operation.id)) return operation

      const helperId = operation.batchId ?? operation.id
      if (
        operation.status === "running" &&
        operationIsStale(operation) &&
        (yield* helperStateEffect(engine, helperId)) === "stopped"
      ) {
        const failed: UpdateOperation = {
          ...operation,
          error:
            "The update helper stopped without reporting an outcome. Inspect its Docker logs before trying again.",
          finishedAt: new Date().toISOString(),
          status: "failed",
        }
        yield* writeOperationEffect(operationsDirectory, failed)
        yield* releaseTargetLockEffect(
          operationsDirectory,
          operation.targetContainer,
          operation.id
        )
        yield* cleanupHelperEffect(engine, helperId)
        return failed
      }

      if (operation.status !== "running") {
        yield* releaseTargetLockEffect(
          operationsDirectory,
          operation.targetContainer,
          operation.id
        )
        if (operation.batchId) {
          yield* cleanupCompletedBatchEffect(
            engine,
            operationsDirectory,
            operation.batchId
          )
        } else {
          yield* cleanupHelperEffect(engine, id)
        }
      }
      return operation
    }).pipe(Effect.withSpan("relay.systemUpdates.status"))
  }
}

const operationFilePattern = /^[0-9a-f-]{36}\.json$/u

const recordedOperationsEffect = Effect.fn("relay.systemUpdates.recorded")(
  function* (directory: string) {
    const names = yield* systemUpdateOperation("operations.list", () =>
      readdir(directory)
    ).pipe(
      Effect.catch((cause) =>
        systemErrorCode(cause) === "ENOENT"
          ? Effect.succeed<Array<string>>([])
          : Effect.fail(cause)
      )
    )
    const operations = yield* Effect.forEach(
      names.filter((name) => operationFilePattern.test(name)),
      (name) =>
        readOperationEffect(directory, name.slice(0, -".json".length)).pipe(
          // One unreadable record must not hide the others.
          Effect.catch(() => Effect.succeed(null))
        ),
      { concurrency: 8 }
    )
    return operations.flatMap((operation) => operation ?? [])
  }
)

function isNewer(operation: UpdateOperation, than: UpdateOperation): boolean {
  return Date.parse(operation.startedAt) > Date.parse(than.startedAt)
}

// Hearth rejects a whole snapshot that breaks its contract, so a long error
// is clamped and a record that still doesn't fit isn't reported.
function reportedUpdate(operation: UpdateOperation): Array<RelaySystemUpdate> {
  const reported = relaySystemUpdateSchema.safeParse({
    component: operation.component,
    error: operation.error?.slice(0, 2_000) ?? null,
    finishedAt: operation.finishedAt,
    id: operation.id,
    ...(operation.phase ? { phase: operation.phase.slice(0, 100) } : {}),
    ...(operation.requestId ? { requestId: operation.requestId } : {}),
    startedAt: operation.startedAt,
    status: operation.status,
    version: operation.version,
  })
  return reported.success ? [reported.data] : []
}

interface PreparedUpdate {
  container: ContainerInspect
  input: SystemUpdateTargetInput
  operation: UpdateOperation
}

const prepareUpdateEffect = Effect.fn("relay.systemUpdates.prepare")(function* (
  engine: DockerEngine,
  input: SystemUpdateTargetInput,
  batchId: string,
  startedAt: string,
  installation: InstallationIdentity,
  gitRepository: string,
  requestId: string | undefined
) {
  const targetComponent = releaseImageComponent(
    input.targetImage,
    gitRepository
  )
  const container = yield* inspectContainerEffect(engine, input.targetContainer)
  const eligibility = updateEligibility(container, installation, gitRepository)
  if (targetComponent === null || eligibility.component !== targetComponent) {
    return yield* systemUpdateFailure(
      "start.validate",
      "The selected container is not a component of this distribution"
    )
  }
  if (!eligibility.eligible) {
    return yield* systemUpdateFailure(
      "start.validate",
      eligibility.reason ?? "This container cannot be updated"
    )
  }
  if (!isKilnReleaseVersion(input.version)) {
    return yield* systemUpdateFailure(
      "start.validate",
      "The requested Kiln release version is invalid"
    )
  }
  if (
    isKilnReleaseVersion(eligibility.currentVersion) &&
    isDefiniteReleaseDowngrade(input.version, eligibility.currentVersion)
  ) {
    return yield* systemUpdateFailure(
      "start.validate",
      `Refusing to downgrade ${eligibility.currentVersion} to ${input.version}`
    )
  }
  const targetReference = managedImageChannel(
    container.Config.Image,
    targetComponent,
    gitRepository
  )
  if (!targetReference) {
    return yield* systemUpdateFailure(
      "start.validate",
      "The target no longer uses a managed channel tag"
    )
  }

  return {
    container,
    input,
    operation: {
      batchId,
      component: targetComponent,
      error: null,
      phase: "Preparing",
      finishedAt: null,
      id: randomUUID(),
      ...(installation.installationId
        ? { installationId: installation.installationId }
        : {}),
      previousImage: container.Config.Image,
      requestedImage: input.targetImage,
      ...(requestId ? { requestId } : {}),
      startedAt,
      status: "running",
      targetContainer: container.Name.replace(/^\//u, ""),
      targetReference,
      version: input.version,
    },
  } satisfies PreparedUpdate
})

function uniqueUpdateImages(
  helperImage: string,
  prepared: ReadonlyArray<PreparedUpdate>
): Array<{ component: KilnComponent; image: string }> {
  const images = new Map<string, KilnComponent>([[helperImage, "relay"]])
  for (const { input, operation } of prepared) {
    images.set(input.targetImage, operation.component)
  }
  return Array.from(images, ([image, component]) => ({ component, image }))
}

function acquireOperationLocksEffect(
  directory: string,
  operations: ReadonlyArray<UpdateOperation>
): Effect.Effect<void, RelaySystemUpdateError> {
  const acquired: Array<UpdateOperation> = []
  const releaseAcquired = () =>
    Effect.forEach(
      acquired,
      (operation) =>
        releaseTargetLockEffect(
          directory,
          operation.targetContainer,
          operation.id
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("System update lock cleanup failed", cause)
          )
        ),
      { concurrency: "unbounded", discard: true }
    )

  return Effect.forEach(
    operations,
    (operation) =>
      acquireTargetLockEffect(directory, operation).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            acquired.push(operation)
          })
        )
      ),
    { discard: true }
  ).pipe(
    Effect.catch((cause) =>
      releaseAcquired().pipe(Effect.andThen(Effect.fail(cause)))
    ),
    Effect.onInterrupt(releaseAcquired),
    Effect.asVoid
  )
}

function failQueuedOperationsEffect(
  directory: string,
  operations: ReadonlyArray<UpdateOperation>,
  message: string
): Effect.Effect<void, RelaySystemUpdateError> {
  const finishedAt = new Date().toISOString()
  return Effect.forEach(
    operations,
    (operation) =>
      writeOperationEffect(directory, {
        ...operation,
        error: message,
        finishedAt,
        status: "failed",
      }).pipe(
        Effect.andThen(
          releaseTargetLockEffect(
            directory,
            operation.targetContainer,
            operation.id
          )
        )
      ),
    { concurrency: "unbounded", discard: true }
  )
}

function launchBatchHelperEffect(
  engine: DockerEngine,
  input: {
    batchId: string
    helperImage: string
    operationsDirectory: string
    volumesFrom: string
  },
  signal?: AbortSignal
): Effect.Effect<void, RelaySystemUpdateError> {
  return systemUpdateEffect(
    "start.launchHelper",
    runContainer(
      engine,
      {
        command: ["dist/src/updater.mjs"],
        env: {
          KILN_UPDATE_DATA_DIR: input.operationsDirectory,
          KILN_UPDATE_BATCH_ID: input.batchId,
        },
        // The helper runs the Relay image without its health endpoint.
        healthcheck: "none",
        image: input.helperImage,
        labels: { "io.kiln.update-helper": "true" },
        name: `kiln-updater-${input.batchId}`,
        volumesFrom: [input.volumesFrom],
      },
      { timeout: 90_000 }
    ),
    signal
  ).pipe(Effect.asVoid)
}

function readBatchEffect(
  directory: string,
  id: string
): Effect.Effect<UpdateBatch | null, RelaySystemUpdateError> {
  return systemUpdateOperation("batch.read", () =>
    readFile(join(directory, `${id}.batch.json`), "utf8")
  ).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const decoded: unknown = JSON.parse(text)
          return decoded
        },
        catch: (cause) =>
          makeSystemUpdateError(
            "batch.decode",
            "The update batch record is invalid",
            cause
          ),
      })
    ),
    Effect.flatMap((decoded) =>
      isUpdateBatch(decoded)
        ? Effect.succeed(decoded)
        : systemUpdateFailure(
            "batch.decode",
            "The update batch record is invalid"
          )
    ),
    Effect.catch((cause) =>
      systemErrorCode(cause) === "ENOENT"
        ? Effect.succeed(null)
        : Effect.fail(cause)
    )
  )
}

function writeBatchEffect(
  directory: string,
  batch: UpdateBatch
): Effect.Effect<void, RelaySystemUpdateError> {
  const path = join(directory, `${batch.id}.batch.json`)
  const temporary = `${path}.${process.pid}.tmp`
  return systemUpdateOperation("batch.writeTemporary", () =>
    writeFile(temporary, `${JSON.stringify(batch, null, 2)}\n`, {
      mode: 0o600,
    })
  ).pipe(
    Effect.andThen(
      systemUpdateOperation("batch.commit", () => rename(temporary, path))
    ),
    Effect.uninterruptible,
    Effect.ensuring(
      removeBestEffortEffect(temporary, "System update batch cleanup failed")
    )
  )
}

function cleanupCompletedBatchEffect(
  engine: DockerEngine,
  directory: string,
  batchId: string
): Effect.Effect<void, RelaySystemUpdateError> {
  return Effect.gen(function* () {
    const batch = yield* readBatchEffect(directory, batchId)
    if (!batch) return
    const operations = yield* Effect.forEach(batch.operationIds, (id) =>
      readOperationEffect(directory, id)
    )
    if (
      operations.some(
        (operation) => !operation || operation.status === "running"
      )
    ) {
      return
    }
    if ((yield* helperStateEffect(engine, batchId)) !== "running") {
      yield* cleanupHelperEffect(engine, batchId)
    }
  })
}

function isDefiniteReleaseDowngrade(
  requestedVersion: string,
  currentVersion: string
): boolean {
  if (
    kilnReleaseVersionCore(requestedVersion) ===
      kilnReleaseVersionCore(currentVersion) &&
    isKilnNightlyVersion(requestedVersion) !==
      isKilnNightlyVersion(currentVersion)
  ) {
    // Same-line stable/nightly ordering depends on release publication time,
    // which Hearth validates before asking Relay to apply the update.
    return false
  }
  return compareKilnReleaseVersions(requestedVersion, currentVersion) === -1
}

function imageVersionMatchesRelease(
  imageVersion: string | undefined,
  releaseVersion: string
): boolean {
  if (imageVersion === releaseVersion) return true
  if (
    isKilnNightlyVersion(releaseVersion) ||
    !isKilnReleaseVersion(imageVersion) ||
    !isKilnNightlyVersion(imageVersion)
  ) {
    return false
  }
  return (
    kilnReleaseVersionCore(imageVersion) ===
    kilnReleaseVersionCore(releaseVersion)
  )
}

function updateEligibility(
  inspected: ContainerInspect,
  installation: InstallationIdentity,
  gitRepository: string
): {
  component: KilnComponent | null
  container: string
  currentImage: string
  currentVersion: string | null
  eligible: boolean
  installationId: string | null
  reason: string | null
  sameInstallation: boolean
} {
  const labels = inspected.Config.Labels ?? {}
  const component = kilnComponent(labels["io.kiln.component"])
  const currentImage = inspected.Config.Image
  const installationId = labels[KILN_INSTALLATION_LABEL]?.trim() || null
  // Containers created before Kiln generated installation IDs have no label.
  // They stay updatable unless KILN_INSTALLATION_ID asks for an exact match,
  // and their replacement gets the label.
  const sameInstallation =
    installationId === (installation.installationId ?? null) ||
    (installationId === null && !installation.installationIdConfigured)
  const official = isKilnGitRepositorySource(
    labels["org.opencontainers.image.source"],
    gitRepository
  )
  const eligibleTag = component
    ? managedImageChannel(currentImage, component, gitRepository)
    : null

  return {
    component,
    container: inspected.Name.replace(/^\//u, ""),
    currentImage,
    currentVersion: labels["org.opencontainers.image.version"]?.trim() || null,
    eligible: Boolean(sameInstallation && component && official && eligibleTag),
    installationId,
    reason: !sameInstallation
      ? "The container belongs to a different Kiln installation."
      : !component
        ? "The container is not a Hearth or Relay image."
        : !official
          ? "Only public images from this distribution can be updated."
          : !eligibleTag
            ? "This container is pinned. Change it to :latest or :latest-nightly to enable one-click updates."
            : null,
    sameInstallation,
  }
}

function inspectContainerEffect(
  engine: DockerEngine,
  container: string
): Effect.Effect<ContainerInspect, RelaySystemUpdateError> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(container)) {
    return systemUpdateFailure(
      "inspect.validate",
      "Invalid Docker container identifier"
    )
  }
  return inspectContainerDirectEffect(engine, container).pipe(
    Effect.catch((directCause) =>
      Effect.gen(function* () {
        const listed = yield* systemUpdateEffect(
          "inspect.listContainers",
          engine.listContainers()
        )
        if (listed.length === 0) return yield* Effect.fail(directCause)
        const inspected = yield* systemUpdateEffect(
          "inspect.inspectCandidates",
          engine.inspectContainers<unknown>(listed.map(({ Id }) => Id))
        )
        if (!inspected.every(isContainerInspect)) {
          return yield* systemUpdateFailure(
            "inspect.decodeCandidates",
            "Docker returned an invalid inspection response"
          )
        }
        const matches = inspected.filter(
          (candidate) => candidate.Config.Hostname === container
        )
        if (matches.length === 1 && matches[0]) return matches[0]
        if (matches.length > 1) {
          return yield* systemUpdateFailure(
            "inspect.resolveHostname",
            `More than one running Docker container uses hostname ${container}`
          )
        }
        return yield* Effect.fail(directCause)
      })
    )
  )
}

// Docker had no container by that ID or name, and none uses it as a hostname.
function isContainerMissing(cause: RelaySystemUpdateError): boolean {
  return (
    cause.phase === "inspect.inspectContainer" && isDockerNotFound(cause.cause)
  )
}

function inspectContainerDirectEffect(
  engine: DockerEngine,
  container: string
): Effect.Effect<ContainerInspect, RelaySystemUpdateError> {
  return systemUpdateEffect(
    "inspect.inspectContainer",
    engine.inspectContainer<unknown>(container)
  ).pipe(
    Effect.flatMap((inspected) =>
      isContainerInspect(inspected)
        ? Effect.succeed(inspected)
        : systemUpdateFailure(
            "inspect.decodeContainer",
            "Docker could not inspect the container"
          )
    )
  )
}

function pullAndVerifyImageEffect(
  engine: DockerEngine,
  image: string,
  expectedComponent: KilnComponent,
  gitRepository: string,
  signal?: AbortSignal
): Effect.Effect<ImageInspect, RelaySystemUpdateError> {
  return Effect.gen(function* () {
    yield* ensureNotAbortedEffect(signal)
    yield* systemUpdateEffect(
      "start.pullImage",
      engine.pullImage(image, { timeout: 10 * 60_000 }),
      signal
    )
    yield* ensureNotAbortedEffect(signal)
    const inspected = yield* systemUpdateEffect(
      "start.inspectImage",
      engine.inspectImage<unknown>(image),
      signal
    )
    if (!isImageInspect(inspected)) {
      return yield* systemUpdateFailure(
        "start.decodeImage",
        "Docker could not inspect the pulled image"
      )
    }
    const labels = inspected.Config?.Labels ?? {}
    if (
      !isKilnGitRepositorySource(
        labels["org.opencontainers.image.source"],
        gitRepository
      ) ||
      labels["io.kiln.component"] !== expectedComponent
    ) {
      return yield* systemUpdateFailure(
        "start.verifyImage",
        `The ${expectedComponent} image failed provenance checks`
      )
    }
    return inspected
  })
}

function releaseImageComponent(
  image: string,
  repository: string
): KilnComponent | null {
  for (const component of ["hearth", "relay"] as const) {
    const prefix = `${kilnImageRepository(component, repository)}@`
    if (
      image.startsWith(prefix) &&
      /^sha256:[a-f0-9]{64}$/u.test(image.slice(prefix.length))
    )
      return component
  }
  return null
}

/**
 * Takes `updates/<container>.lock` for `operation`. A Relay in platform mode
 * takes the same lock, by the same protocol, while it changes one of Kiln's
 * services (platform.ts), so the two never act on a container at once.
 */
export function acquireTargetLockEffect(
  directory: string,
  operation: Pick<UpdateOperation, "id" | "targetContainer">
): Effect.Effect<void, RelaySystemUpdateError> {
  const path = targetLockPath(directory, operation.targetContainer)
  return Effect.suspend(() => {
    const temporary = `${path}.${operation.id}.tmp`
    return Effect.gen(function* () {
      yield* systemUpdateOperation("lock.writeCandidate", () =>
        writeFile(temporary, `${operation.id}\n`, {
          flag: "wx",
          mode: 0o600,
        })
      )
      return yield* systemUpdateOperation("lock.acquire", () =>
        link(temporary, path)
      ).pipe(
        Effect.catch((cause) => {
          if (systemErrorCode(cause) !== "EEXIST") return Effect.fail(cause)
          return Effect.gen(function* () {
            const existingId = (yield* systemUpdateOperation("lock.read", () =>
              readFile(path, "utf8")
            )).trim()
            const existing = existingId
              ? yield* readOperationEffect(directory, existingId)
              : null
            if (!existing) {
              if (yield* lockIsOrphanedEffect(path)) {
                yield* releaseTargetLockEffect(
                  directory,
                  operation.targetContainer,
                  existingId
                )
                yield* removeBestEffortEffect(
                  temporary,
                  "System update lock cleanup failed"
                )
                return yield* acquireTargetLockEffect(directory, operation)
              }
              return yield* systemUpdateFailure(
                "lock.acquire",
                // A Relay in platform mode holds it while it repairs or
                // restarts one of Kiln's services (platform.ts).
                existingId.startsWith("platform-")
                  ? `Kiln is repairing ${operation.targetContainer}; try again in a moment`
                  : `An update is starting for ${operation.targetContainer}`
              )
            }
            if (existing.status === "running") {
              return yield* systemUpdateFailure(
                "lock.acquire",
                `An update is already running for ${operation.targetContainer}`
              )
            }
            yield* releaseTargetLockEffect(
              directory,
              operation.targetContainer,
              existingId
            )
            yield* removeBestEffortEffect(
              temporary,
              "System update lock cleanup failed"
            )
            return yield* acquireTargetLockEffect(directory, operation)
          })
        })
      )
    }).pipe(
      Effect.uninterruptible,
      Effect.ensuring(
        removeBestEffortEffect(temporary, "System update lock cleanup failed")
      )
    )
  })
}

function lockIsOrphanedEffect(
  path: string
): Effect.Effect<boolean, RelaySystemUpdateError> {
  return systemUpdateOperation("lock.stat", () => stat(path)).pipe(
    Effect.map((metadata) => Date.now() - metadata.mtimeMs > ORPHAN_LOCK_MS),
    Effect.catch((cause) =>
      systemErrorCode(cause) === "ENOENT"
        ? Effect.succeed(true)
        : Effect.fail(cause)
    )
  )
}

export function releaseTargetLockEffect(
  directory: string,
  targetContainer: string,
  operationId: string
): Effect.Effect<void, RelaySystemUpdateError> {
  const path = targetLockPath(directory, targetContainer)
  return systemUpdateOperation("lock.readForRelease", () =>
    readFile(path, "utf8")
  ).pipe(
    Effect.flatMap((owner) =>
      owner.trim() !== operationId
        ? Effect.void
        : systemUpdateOperation("lock.release", () => rm(path, { force: true }))
    ),
    Effect.catch((cause) =>
      systemErrorCode(cause) === "ENOENT" ? Effect.void : Effect.fail(cause)
    )
  )
}

function targetLockPath(directory: string, targetContainer: string): string {
  return join(directory, `${targetContainer}.lock`)
}

function helperStateEffect(
  engine: DockerEngine,
  id: string
): Effect.Effect<"running" | "stopped" | "unknown", RelaySystemUpdateError> {
  const helperName = `kiln-updater-${id}`
  return systemUpdateEffect(
    "status.inspectHelper",
    engine.inspectContainer<unknown>(helperName)
  ).pipe(
    Effect.flatMap((inspected) =>
      isHelperInspect(inspected)
        ? Effect.succeed(
            inspected.State?.Running ? ("running" as const) : ("stopped" as const)
          )
        : systemUpdateFailure(
            "status.decodeHelper",
            "Docker returned an invalid inspection response"
          )
    ),
    Effect.catch(() =>
      systemUpdateEffect(
        "status.findHelper",
        engine.listContainers({
          all: true,
          filters: { name: [`^/${helperName}$`] },
        })
      ).pipe(
        Effect.map((listed) =>
          listed.length > 0 ? ("unknown" as const) : ("stopped" as const)
        ),
        Effect.catch(() => Effect.succeed("unknown" as const))
      )
    )
  )
}

function cleanupHelperEffect(
  engine: DockerEngine,
  id: string
): Effect.Effect<void> {
  return systemUpdateEffect(
    "helper.cleanup",
    engine.removeContainer(`kiln-updater-${id}`, { force: true })
  ).pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.logWarning("System update helper cleanup failed", cause)
    )
  )
}

function operationIsStale(operation: UpdateOperation): boolean {
  const startedAt = Date.parse(operation.startedAt)
  return Number.isFinite(startedAt) && Date.now() - startedAt > STALE_UPDATE_MS
}

function readOperationEffect(
  directory: string,
  id: string
): Effect.Effect<UpdateOperation | null, RelaySystemUpdateError> {
  return systemUpdateOperation("operation.read", () =>
    readFile(join(directory, `${id}.json`), "utf8")
  ).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          makeSystemUpdateError(
            "operation.decode",
            "The update operation record is invalid",
            cause
          ),
      })
    ),
    Effect.flatMap((decoded) =>
      isUpdateOperation(decoded)
        ? Effect.succeed(decoded)
        : systemUpdateFailure(
            "operation.decode",
            "The update operation record is invalid"
          )
    ),
    Effect.catch((cause) =>
      systemErrorCode(cause) === "ENOENT"
        ? Effect.succeed(null)
        : Effect.fail(cause)
    )
  )
}

function writeOperationEffect(
  directory: string,
  operation: UpdateOperation
): Effect.Effect<void, RelaySystemUpdateError> {
  const path = join(directory, `${operation.id}.json`)
  const temporary = `${path}.${process.pid}.tmp`
  return Effect.gen(function* () {
    yield* systemUpdateOperation("operation.writeTemporary", () =>
      writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, {
        mode: 0o600,
      })
    )
    yield* systemUpdateOperation("operation.commit", () =>
      rename(temporary, path)
    ).pipe(Effect.uninterruptible)
  }).pipe(
    Effect.uninterruptible,
    Effect.ensuring(
      removeBestEffortEffect(
        temporary,
        "System update operation cleanup failed"
      )
    )
  )
}

function ensureNotAbortedEffect(
  signal: AbortSignal | undefined
): Effect.Effect<void, RelaySystemUpdateError> {
  return signal?.aborted
    ? systemUpdateFailure(
        "request.cancelled",
        abortReason(signal).message,
        abortReason(signal)
      )
    : Effect.void
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Relay request was cancelled")
}

function errorCode(cause: unknown): string | null {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code
  }
  return null
}

function systemErrorCode(cause: RelaySystemUpdateError): string | null {
  return errorCode(cause.cause)
}

function systemUpdateOperation<TResult>(
  phase: string,
  run: () => Promise<TResult>
): Effect.Effect<TResult, RelaySystemUpdateError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => makeSystemUpdateError(phase, undefined, cause),
  })
}

/**
 * A Docker request as a step of an update, failing with its phase; with a
 * signal, it stops when the request that started the update is cancelled.
 */
function systemUpdateEffect<A>(
  phase: string,
  operation: Effect.Effect<A, Error>,
  signal?: AbortSignal
): Effect.Effect<A, RelaySystemUpdateError> {
  const mapped = operation.pipe(
    Effect.mapError((cause) => makeSystemUpdateError(phase, undefined, cause))
  )
  if (!signal) return mapped
  const cancelled = Effect.callback<never, RelaySystemUpdateError>((resume) => {
    const abort = () =>
      resume(
        systemUpdateFailure(
          "request.cancelled",
          abortReason(signal).message,
          abortReason(signal)
        )
      )
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
  return Effect.raceFirst(mapped, cancelled)
}

function systemUpdateFailure(
  phase: string,
  reason: string,
  cause?: unknown
): Effect.Effect<never, RelaySystemUpdateError> {
  return Effect.fail(makeSystemUpdateError(phase, reason, cause))
}

function makeSystemUpdateError(
  phase: string,
  reason: string | undefined,
  cause: unknown
): RelaySystemUpdateError {
  return cause instanceof RelaySystemUpdateError
    ? cause
    : RelaySystemUpdateError.make({
        phase,
        reason:
          reason ??
          (cause instanceof Error ? cause.message : "System update failed"),
        cause,
        rollbackFailures: [],
      })
}

function removeBestEffortEffect(
  path: string,
  warning: string
): Effect.Effect<void> {
  return systemUpdateOperation("cleanup.removeTemporary", () =>
    rm(path, { force: true })
  ).pipe(
    Effect.asVoid,
    Effect.catch((cause) => Effect.logWarning(warning, cause))
  )
}

function isContainerInspect(value: unknown): value is ContainerInspect {
  if (!isRecord(value) || !isRecord(value.Config)) return false
  return (
    typeof value.Config.Image === "string" &&
    optionalString(value.Config.Hostname) &&
    stringRecordOrNull(value.Config.Labels) &&
    typeof value.Id === "string" &&
    typeof value.Name === "string"
  )
}

function isImageInspect(value: unknown): value is ImageInspect {
  if (!isRecord(value)) return false
  if (value.Config === undefined) return true
  return isRecord(value.Config) && stringRecordOrNull(value.Config.Labels)
}

function isHelperInspect(value: unknown): value is HelperInspect {
  if (!isRecord(value)) return false
  if (value.State === undefined) return true
  return (
    isRecord(value.State) &&
    (value.State.Running === undefined ||
      typeof value.State.Running === "boolean")
  )
}

function isUpdateOperation(value: unknown): value is UpdateOperation {
  if (!isRecord(value)) return false
  return (
    optionalString(value.batchId) &&
    (value.component === "hearth" || value.component === "relay") &&
    (value.error === null || typeof value.error === "string") &&
    optionalString(value.phase) &&
    (value.finishedAt === null || typeof value.finishedAt === "string") &&
    typeof value.id === "string" &&
    optionalString(value.installationId) &&
    typeof value.previousImage === "string" &&
    typeof value.requestedImage === "string" &&
    optionalString(value.requestId) &&
    typeof value.startedAt === "string" &&
    (value.status === "failed" ||
      value.status === "running" ||
      value.status === "succeeded") &&
    typeof value.targetContainer === "string" &&
    optionalString(value.targetReference) &&
    typeof value.version === "string"
  )
}

function isUpdateBatch(value: unknown): value is UpdateBatch {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.operationIds) &&
    value.operationIds.every((id) => typeof id === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function stringRecordOrNull(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) &&
      Object.values(value).every(
        (entry) => entry === undefined || typeof entry === "string"
      ))
  )
}
