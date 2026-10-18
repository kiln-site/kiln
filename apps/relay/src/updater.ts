import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"

import { DockerEngine } from "./docker-engine.js"
import { RelaySystemUpdateError } from "./effect/errors.js"
import { replaceContainerEffect } from "./update-container.js"
import {
  drainUpdateBatchEffect,
  retryContainerReplacementEffect,
} from "./updater-effects.js"

// The helper runs from the Relay image with the Relay's volumes, so it has
// the Relay's Docker socket.
const docker = new DockerEngine("/var/run/docker.sock")

interface UpdateOperation {
  batchId?: string
  component: "hearth" | "relay"
  error: string | null
  phase?: string
  finishedAt: string | null
  id: string
  installationId?: string
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

const operationsDirectory = requiredEnvironment("KILN_UPDATE_DATA_DIR")
const batchId = optionalEnvironment("KILN_UPDATE_BATCH_ID")

const runOperationEffect = Effect.fn("relay.updater.replace")(function* (
  operation: UpdateOperation,
  legacyReference?: string
) {
  const targetReference = operation.targetReference ?? legacyReference
  if (!targetReference) {
    return yield* Effect.fail(
      updaterError(
        "validateOperation",
        "The update target reference is missing",
        operation
      )
    )
  }
  const backupName = `${operation.targetContainer}-kiln-backup-${Date.now()}`
  yield* retryContainerReplacementEffect(
    replaceContainerEffect(
      {
        backupName,
        installationId: operation.installationId,
        targetContainer: operation.targetContainer,
        targetImage: operation.requestedImage,
        targetReference,
        targetVersion: operation.version,
      },
      docker,
      (phase) =>
        updateOperationEffect({ ...operation, phase }).pipe(
          Effect.catch(() => Effect.void)
        )
    )
  )
  yield* updateOperationEffect({
    ...operation,
    error: null,
    finishedAt: new Date().toISOString(),
    status: "succeeded",
  })
})

const runRecordedOperationEffect = Effect.fn(
  "relay.updater.runRecordedOperation"
)(function* (operation: UpdateOperation, legacyReference?: string) {
  yield* runOperationEffect(operation, legacyReference).pipe(
    Effect.catch((cause) =>
      updateOperationEffect({
        ...operation,
        error: cause.message,
        finishedAt: new Date().toISOString(),
        status: "failed",
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          })
        )
      )
    )
  )
})

const runBatchEffect = Effect.fn("relay.updater.runBatch")(function* (
  activeBatchId: string
) {
  // Return the operation ids before replacing Relay and keep a short idle
  // window so another Hearth request can join this sidecar's queue.
  yield* Effect.sleep("1500 millis")
  yield* drainUpdateBatchEffect(() =>
    Effect.gen(function* () {
      const batch = yield* readBatchEffect(activeBatchId)
      const operations = yield* Effect.forEach(batch.operationIds, (id) =>
        readOperationEffect(id)
      )
      const pending = operations
        .filter((operation) => operation.status === "running")
        .sort((left, right) =>
          left.component === right.component
            ? 0
            : left.component === "hearth"
              ? -1
              : 1
        )
      if (pending.length === 0) return false
      yield* Effect.forEach(
        pending,
        (operation) => runRecordedOperationEffect(operation),
        { discard: true }
      )
      return true
    })
  )
})

const runLegacyEffect = Effect.fn("relay.updater.runLegacy")(function* () {
  const operationId = requiredEnvironment("KILN_UPDATE_OPERATION_ID")
  const operation = yield* readOperationEffect(operationId)
  yield* Effect.sleep("1500 millis")
  yield* runRecordedOperationEffect(
    operation,
    requiredEnvironment("KILN_UPDATE_TARGET_REFERENCE")
  )
})

const updaterEffect = (
  batchId ? runBatchEffect(batchId) : runLegacyEffect()
).pipe(Effect.withSpan("relay.updater.run"))

await Effect.runPromise(updaterEffect)

function readOperationEffect(id: string) {
  return updaterOperation("readOperation", () =>
    readFile(operationPath(id), "utf8")
  ).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const decoded: unknown = JSON.parse(text)
          if (!isUpdateOperation(decoded)) {
            throw new Error("Invalid update operation")
          }
          return decoded
        },
        catch: (cause) =>
          updaterError("decodeOperation", "Invalid update operation", cause),
      })
    )
  )
}

function readBatchEffect(id: string) {
  return updaterOperation("readBatch", () =>
    readFile(join(operationsDirectory, `${id}.batch.json`), "utf8")
  ).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => {
          const decoded: unknown = JSON.parse(text)
          if (!isUpdateBatch(decoded) || decoded.id !== id) {
            throw new Error("Invalid update batch")
          }
          return decoded
        },
        catch: (cause) =>
          updaterError("decodeBatch", "Invalid update batch", cause),
      })
    )
  )
}

function updateOperationEffect(operation: UpdateOperation) {
  const path = operationPath(operation.id)
  const temporary = `${path}.${process.pid}.tmp`
  return Effect.gen(function* () {
    yield* updaterOperation("createOperationDirectory", () =>
      mkdir(operationsDirectory, { recursive: true, mode: 0o700 })
    )
    yield* updaterOperation("writeOperation", () =>
      writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, {
        mode: 0o600,
      })
    )
    yield* updaterOperation("commitOperation", () =>
      rename(temporary, path)
    ).pipe(Effect.uninterruptible)
  }).pipe(
    Effect.uninterruptible,
    Effect.ensuring(
      updaterOperation("cleanupOperation", () =>
        rm(temporary, { force: true })
      ).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("System updater operation cleanup failed", cause)
        )
      )
    )
  )
}

function updaterOperation<TResult>(phase: string, run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => updaterError(phase, undefined, cause),
  })
}

function updaterError(
  phase: string,
  reason: string | undefined,
  cause: unknown
) {
  return cause instanceof RelaySystemUpdateError
    ? cause
    : RelaySystemUpdateError.make({
        phase: `updater.${phase}`,
        reason:
          reason ??
          (cause instanceof Error ? cause.message : "System update failed"),
        cause,
        rollbackFailures: [],
      })
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalEnvironment(name: string): string | null {
  return process.env[name]?.trim() || null
}

function operationPath(id: string): string {
  return join(operationsDirectory, `${id}.json`)
}

function isUpdateOperation(value: unknown): value is UpdateOperation {
  return (
    isRecord(value) &&
    optionalString(value.batchId) &&
    (value.component === "hearth" || value.component === "relay") &&
    (value.error === null || typeof value.error === "string") &&
    optionalString(value.phase) &&
    (value.finishedAt === null || typeof value.finishedAt === "string") &&
    typeof value.id === "string" &&
    optionalString(value.installationId) &&
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
