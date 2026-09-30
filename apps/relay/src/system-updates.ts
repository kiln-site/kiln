import { randomUUID } from "node:crypto"
import {
  link,
  mkdir,
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
} from "@workspace/contracts"
import { Effect, Semaphore } from "effect"

import { command } from "./command.js"
import type { CommandOptions, CommandResult } from "./command.js"
import { RelaySystemUpdateError } from "./effect/errors.js"
import {
  KILN_INSTALLATION_LABEL,
  kilnComponent,
  managedImageChannel,
  type KilnComponent,
} from "./update-container.js"

const STALE_UPDATE_MS = 10 * 60_000
const ORPHAN_LOCK_MS = 30_000

type RunCommand = (
  executable: string,
  arguments_: Array<string>,
  options?: CommandOptions
) => Promise<CommandResult>

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
  previousImage: string
  requestedImage: string
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

interface SystemUpdateTargetInput {
  targetContainer: string
  targetImage: string
  version: string
}

export class SystemUpdateManager {
  readonly #batchSemaphore = Semaphore.makeUnsafe(1)
  readonly #command: RunCommand
  readonly #installationId: string | null
  readonly #gitRepository: string
  readonly #operationsDirectory: string
  #activeBatch: { id: string } | null = null

  constructor(
    config: {
      dataDirectory: string
      gitRepository?: string
      installationId?: string | null
    },
    runCommand: RunCommand = command
  ) {
    this.#command = runCommand
    this.#gitRepository = config.gitRepository ?? DEFAULT_KILN_GIT_REPO
    this.#installationId = config.installationId ?? null
    this.#operationsDirectory = join(config.dataDirectory, "updates")
  }

  inspect(container: string) {
    return inspectContainerEffect(container, this.#command).pipe(
      Effect.map((inspected) =>
        updateEligibility(inspected, this.#installationId, this.#gitRepository)
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
      targets: ReadonlyArray<SystemUpdateTargetInput>
    },
    signal?: AbortSignal
  ) {
    const runCommand = this.#command
    const installationId = this.#installationId
    const gitRepository = this.#gitRepository
    const operationsDirectory = this.#operationsDirectory
    const setActiveBatch = (id: string) => {
      this.#activeBatch = { id }
    }
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
              targetInput,
              batchId,
              startedAt,
              installationId,
              gitRepository,
              runCommand
            ),
          { concurrency: "unbounded" }
        )
        const prepared = preparedTargets.sort((left, right) =>
          left.operation.component === right.operation.component
            ? 0
            : left.operation.component === "hearth"
              ? -1
              : 1
        )
        const operations = prepared.map(({ operation }) => operation)

        yield* acquireOperationLocksEffect(operationsDirectory, operations)
        const failOperations = (cause: RelaySystemUpdateError) =>
          failQueuedOperationsEffect(
            operationsDirectory,
            operations,
            signal?.aborted
              ? "The update request was cancelled before replacement started."
              : cause.message
          )

        return yield* Effect.gen(function* () {
          const images = uniqueUpdateImages(input.helperImage, prepared)
          const inspectedImages = yield* Effect.forEach(
            images,
            ({ component, image }) =>
              pullAndVerifyImageEffect(
                image,
                component,
                gitRepository,
                runCommand,
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
            (yield* inspectContainerEffect(hostname(), runCommand))
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

          yield* Effect.forEach(
            operations,
            (operation) => writeOperationEffect(operationsDirectory, operation),
            { discard: true }
          )
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
            ? yield* helperStateEffect(runCommand, batchId)
            : "stopped"
          if (helperState !== "running") {
            yield* cleanupHelperEffect(runCommand, batchId)
            yield* launchBatchHelperEffect(
              runCommand,
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
                signal?.aborted
                  ? systemUpdateFailure(
                      "start.cancelled",
                      abortReason(signal).message,
                      abortReason(signal)
                    )
                  : Effect.succeed(
                      operations.map((operation): UpdateOperation => ({
                        ...operation,
                        error: cause.message,
                        finishedAt: new Date().toISOString(),
                        status: "failed",
                      }))
                    )
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
          )
        )
      }).pipe(Effect.withSpan("relay.systemUpdates.startBatch"))
    )
  }

  #runningBatchEffect() {
    const active = this.#activeBatch
    if (!active) return Effect.succeed<UpdateBatch | null>(null)
    return helperStateEffect(this.#command, active.id).pipe(
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
    const operationsDirectory = this.#operationsDirectory
    const runCommand = this.#command
    return Effect.gen(function* () {
      if (!/^[0-9a-f-]{36}$/u.test(id)) return null
      const operation = yield* readOperationEffect(operationsDirectory, id)
      if (!operation) return null

      const helperId = operation.batchId ?? operation.id
      if (
        operation.status === "running" &&
        operationIsStale(operation) &&
        (yield* helperStateEffect(runCommand, helperId)) === "stopped"
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
        yield* cleanupHelperEffect(runCommand, helperId)
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
            operationsDirectory,
            operation.batchId,
            runCommand
          )
        } else {
          yield* cleanupHelperEffect(runCommand, id)
        }
      }
      return operation
    }).pipe(Effect.withSpan("relay.systemUpdates.status"))
  }
}

interface PreparedUpdate {
  container: ContainerInspect
  input: SystemUpdateTargetInput
  operation: UpdateOperation
}

const prepareUpdateEffect = Effect.fn("relay.systemUpdates.prepare")(function* (
  input: SystemUpdateTargetInput,
  batchId: string,
  startedAt: string,
  installationId: string | null,
  gitRepository: string,
  runCommand: RunCommand
) {
  const targetComponent = releaseImageComponent(
    input.targetImage,
    gitRepository
  )
  const container = yield* inspectContainerEffect(
    input.targetContainer,
    runCommand
  )
  const eligibility = updateEligibility(
    container,
    installationId,
    gitRepository
  )
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
      previousImage: container.Config.Image,
      requestedImage: input.targetImage,
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
  runCommand: RunCommand,
  input: {
    batchId: string
    helperImage: string
    operationsDirectory: string
    volumesFrom: string
  },
  signal?: AbortSignal
): Effect.Effect<void, RelaySystemUpdateError> {
  return systemUpdateOperation("start.launchHelper", () =>
    runCommand(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        `kiln-updater-${input.batchId}`,
        "--label",
        "io.kiln.update-helper=true",
        "--volumes-from",
        input.volumesFrom,
        "--env",
        `KILN_UPDATE_DATA_DIR=${input.operationsDirectory}`,
        "--env",
        `KILN_UPDATE_BATCH_ID=${input.batchId}`,
        input.helperImage,
        "dist/src/updater.mjs",
      ],
      { signal, timeout: 90_000 }
    )
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
  directory: string,
  batchId: string,
  runCommand: RunCommand
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
    if ((yield* helperStateEffect(runCommand, batchId)) !== "running") {
      yield* cleanupHelperEffect(runCommand, batchId)
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

export function imageVersionMatchesRelease(
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
  expectedInstallationId: string | null,
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
  const sameInstallation = installationId === expectedInstallationId
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
  container: string,
  runCommand: RunCommand
): Effect.Effect<ContainerInspect, RelaySystemUpdateError> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(container)) {
    return systemUpdateFailure(
      "inspect.validate",
      "Invalid Docker container identifier"
    )
  }
  return inspectContainerDirectEffect(container, runCommand).pipe(
    Effect.catch((directCause) =>
      Effect.gen(function* () {
        const listed = yield* systemUpdateOperation(
          "inspect.listContainers",
          () => runCommand("docker", ["ps", "--quiet"])
        )
        const identifiers = listed.stdout.split(/\s+/u).filter(Boolean)
        if (identifiers.length === 0) return yield* Effect.fail(directCause)
        const result = yield* systemUpdateOperation(
          "inspect.inspectCandidates",
          () => runCommand("docker", ["inspect", ...identifiers])
        )
        const inspected = yield* decodeJsonArrayEffect(
          "inspect.decodeCandidates",
          result.stdout,
          isContainerInspect
        )
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

function inspectContainerDirectEffect(
  container: string,
  runCommand: RunCommand
): Effect.Effect<ContainerInspect, RelaySystemUpdateError> {
  return Effect.gen(function* () {
    const result = yield* systemUpdateOperation(
      "inspect.inspectContainer",
      () => runCommand("docker", ["inspect", container])
    )
    const inspected = (yield* decodeJsonArrayEffect(
      "inspect.decodeContainer",
      result.stdout,
      isContainerInspect
    ))[0]
    if (!inspected) {
      return yield* systemUpdateFailure(
        "inspect.decodeContainer",
        "Docker could not inspect the container"
      )
    }
    return inspected
  })
}

function pullAndVerifyImageEffect(
  image: string,
  expectedComponent: KilnComponent,
  gitRepository: string,
  runCommand: RunCommand,
  signal?: AbortSignal
): Effect.Effect<ImageInspect, RelaySystemUpdateError> {
  return Effect.gen(function* () {
    yield* ensureNotAbortedEffect(signal)
    yield* systemUpdateOperation("start.pullImage", () =>
      runCommand("docker", ["pull", image], {
        signal,
        timeout: 10 * 60_000,
      })
    )
    yield* ensureNotAbortedEffect(signal)
    const result = yield* systemUpdateOperation("start.inspectImage", () =>
      runCommand("docker", ["image", "inspect", image], { signal })
    )
    const inspected = (yield* decodeJsonArrayEffect(
      "start.decodeImage",
      result.stdout,
      isImageInspect
    ))[0]
    if (!inspected) {
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

function acquireTargetLockEffect(
  directory: string,
  operation: UpdateOperation
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
                `An update is starting for ${operation.targetContainer}`
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

function releaseTargetLockEffect(
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
  runCommand: RunCommand,
  id: string
): Effect.Effect<"running" | "stopped" | "unknown", RelaySystemUpdateError> {
  const helperName = `kiln-updater-${id}`
  return Effect.gen(function* () {
    const result = yield* systemUpdateOperation("status.inspectHelper", () =>
      runCommand("docker", ["inspect", helperName])
    )
    const inspected = (yield* decodeJsonArrayEffect(
      "status.decodeHelper",
      result.stdout,
      isHelperInspect
    ))[0]
    return inspected?.State?.Running ? "running" : "stopped"
  }).pipe(
    Effect.catch(() =>
      systemUpdateOperation("status.findHelper", () =>
        runCommand("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `name=^/${helperName}$`,
        ])
      ).pipe(
        Effect.map((result) => (result.stdout.trim() ? "unknown" : "stopped")),
        Effect.catch(() => Effect.succeed("unknown" as const))
      )
    )
  )
}

function cleanupHelperEffect(
  runCommand: RunCommand,
  id: string
): Effect.Effect<void> {
  return systemUpdateOperation("helper.cleanup", () =>
    runCommand("docker", ["rm", "--force", `kiln-updater-${id}`])
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

function decodeJsonArrayEffect<T>(
  phase: string,
  text: string,
  predicate: (value: unknown) => value is T
): Effect.Effect<Array<T>, RelaySystemUpdateError> {
  return Effect.try({
    try: () => decodeJsonArray(text, predicate),
    catch: (cause) =>
      makeSystemUpdateError(
        phase,
        "Docker returned an invalid inspection response",
        cause
      ),
  })
}

function decodeJsonArray<T>(
  text: string,
  predicate: (value: unknown) => value is T
): Array<T> {
  const decoded: unknown = JSON.parse(text)
  if (!Array.isArray(decoded) || !decoded.every(predicate)) {
    throw new Error("Docker returned an invalid inspection response")
  }
  return decoded
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
    typeof value.previousImage === "string" &&
    typeof value.requestedImage === "string" &&
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
