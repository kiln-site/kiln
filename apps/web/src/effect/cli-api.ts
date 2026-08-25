import { randomUUID } from "node:crypto"

import type { CliPrincipal } from "@/effect/cli-access"
import {
  cliActivityResponseSchema,
  cliBackupDownloadRequestSchema,
  cliBackupDownloadResponseSchema,
  cliBackupMutationResponseSchema,
  cliBackupTargetsResponseSchema,
  cliBackupsResponseSchema,
  cliCreateServerRequestSchema,
  cliCreateBackupRequestSchema,
  cliDeleteBackupRequestSchema,
  cliDeleteBackupResponseSchema,
  cliDeleteServerRequestSchema,
  cliFileTargetSchema,
  cliFileWriteRequestSchema,
  cliPowerRequestSchema,
  cliPowerResponseSchema,
  cliRelayInfoResponseSchema,
  cliRelaySchema,
  cliRelaysResponseSchema,
  cliRestoreBackupRequestSchema,
  cliRestoreBackupResponseSchema,
  cliRemoteFileUploadRequestSchema,
  cliRemoteFileUploadResponseSchema,
  cliServerSchema,
  cliServerInfoResponseSchema,
  cliServerMutationResponseSchema,
  cliSftpResponseSchema,
  cliUpdateServerStartupRequestSchema,
  databaseEngineSupportsLogicalBackups,
  relayConsoleCommandResultSchema,
  relayConsoleSchema,
  relayFileContentSchema,
  relayFileTreeSchema,
  relayInstanceSchema,
  relayRemoteFileUploadSchema,
  relayRemoteFileUploadResultSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect, Option, Result } from "effect"
import { z } from "zod"

import { cliRelaySubject, requireCliWrite } from "@/effect/cli-access"
import {
  listBackupCatalogEffect,
  reserveBackupDeleteEffect,
  reserveBackupExportEffect,
  reserveBackupRestoreEffect,
  reserveDatabaseBackupEffect,
  reserveInstanceBackupEffect,
  reservePlatformBackupEffect,
  type BackupCatalogRecord,
  type BackupDispatch,
} from "@/effect/backups"
import {
  loadBackupStorageCredentialEffect,
  loadBackupStorageEffect,
} from "@/backups/destinations/s3"
import { CliAccessError, RelayUnavailableError } from "@/effect/errors"
import {
  allowedInstanceIdsEffect,
  hasPlatformPermission,
  isPlatformAdmin,
  isRelayCreator,
  listUserGrantsEffect,
  requireRelayPermissionEffect,
} from "@/lib/access-control"
import { hasBackupPermission } from "@/lib/backup-access"
import { signLocalBackupDownload } from "@/backups/destinations/local"
import { signS3BackupDownload } from "@/backups/destinations/s3"
import type { AccessPermission } from "@/lib/permissions"
import { roleHasPermission } from "@/lib/permissions"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { relayRpc } from "@/lib/relay-connection"
import {
  dispatchBackupTask,
  reconcileRelayBackups,
  scheduleBackupReconciliation,
} from "@/lib/backup-reconciliation"
import { deleteInstanceWithFinalBackup } from "@/lib/final-instance-deletion"
import { kilnInstallationId } from "@/lib/environment"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { getActivityForUser } from "@/server/activity-data.server"
import { provisionInstanceDomainBestEffort } from "@/server/domains.server"
import { visibleBrickCatalogs } from "@/server/brick-catalogs.server"

const CLI_RELAY_LONG_OPERATION_TIMEOUT_MS = 180_000

type RelaySftpConnection = NonNullable<
  z.infer<typeof relaySnapshotSchema>["relay"]
>["sftp"]

export const collectAvailableCliRelaySnapshotsEffect = Effect.fn(
  "cli.api.servers.collectAvailableRelays"
)(function* <TSnapshot>(
  requests: ReadonlyArray<{
    relayId: string
    snapshot: Effect.Effect<TSnapshot, CliAccessError>
  }>
) {
  const snapshots = yield* Effect.forEach(
    requests,
    ({ relayId, snapshot }) =>
      snapshot.pipe(
        Effect.map(Option.some),
        Effect.catchTag("CliAccessError", (error) =>
          Effect.logWarning(
            "Skipping unavailable Relay while listing CLI servers",
            error
          ).pipe(
            Effect.annotateLogs({
              "kiln.error_code": error.code,
              "kiln.relay_id": relayId,
            }),
            Effect.as(Option.none<TSnapshot>())
          )
        )
      ),
    { concurrency: 4 }
  )
  return snapshots.filter(Option.isSome).map((snapshot) => snapshot.value)
})

export const listCliServersEffect = Effect.fn("cli.api.servers.list")(
  function* (principal: CliPrincipal) {
    const relays = (yield* listPersistedRelaysEffect()).filter(
      (relay) => relay.enabled
    )
    const availableSnapshots = yield* collectAvailableCliRelaySnapshotsEffect(
      relays.map((relay) => ({
        relayId: relay.id,
        snapshot: relayRpcEffect(relay, "relay.snapshot", {}, principal).pipe(
          Effect.flatMap((value) => parseRelaySnapshot(value)),
          Effect.map((snapshot) => ({ relay, snapshot }))
        ),
      }))
    )
    const snapshots = yield* Effect.forEach(
      availableSnapshots,
      ({ relay, snapshot }) =>
        allowedInstanceIdsEffect(
          principal.user,
          relay.id,
          snapshot.instances.map((instance) => instance.id)
        ).pipe(
          Effect.map((allowed) => ({
            instances: snapshot.instances.filter((instance) =>
              allowed.has(instance.id)
            ),
            relay,
          }))
        ),
      { concurrency: 4 }
    )
    return {
      servers: snapshots.flatMap(({ instances, relay }) =>
        instances.map((instance) =>
          cliServerSchema.parse({
            id: `${relay.id}:${instance.id}`,
            instanceId: instance.id,
            name: instance.name,
            relayId: relay.id,
            relayName: relay.name,
            shortId: instance.shortId,
            state: instance.observedState,
          })
        )
      ),
    }
  }
)

export const listCliRelaysEffect = Effect.fn("cli.api.relays.list")(function* (
  principal: CliPrincipal
) {
  const relays = (yield* listPersistedRelaysEffect()).filter(
    (relay) => relay.enabled
  )
  const visibleRelayIds = isPlatformAdmin(principal.user)
    ? new Set(relays.map((relay) => relay.id))
    : new Set(
        (yield* listUserGrantsEffect(principal.user.id)).flatMap((grant) =>
          grant.resourceType === "relay" &&
          roleHasPermission(grant.role, "relay.read")
            ? [grant.relayId]
            : []
        )
      )
  const visible = relays.filter((relay) => visibleRelayIds.has(relay.id))
  const snapshots = yield* Effect.forEach(
    visible,
    (relay) =>
      relayRpcEffect(relay, "relay.snapshot", {}, principal).pipe(
        Effect.flatMap(parseRelaySnapshot),
        Effect.map(Option.some),
        Effect.catchTag("CliAccessError", () =>
          Effect.succeed(Option.none<z.infer<typeof relaySnapshotSchema>>())
        ),
        Effect.map((snapshot) => ({ relay, snapshot }))
      ),
    { concurrency: 4 }
  )
  return cliRelaysResponseSchema.parse({
    relays: snapshots.map(({ relay, snapshot }) =>
      cliRelaySummary(relay, Option.getOrNull(snapshot))
    ),
  })
})

export const getCliRelayInfoEffect = Effect.fn("cli.api.relays.info")(
  function* (principal: CliPrincipal, relayId: string) {
    const relay = yield* authorizeRelay(principal, relayId, "relay.read")
    const snapshot = yield* relayRpcEffect(
      relay,
      "relay.snapshot",
      {},
      principal
    ).pipe(Effect.flatMap(parseRelaySnapshot))
    return cliRelayInfoResponseSchema.parse({
      relay: cliRelaySummary(relay, snapshot),
      node: {
        connectedAt: snapshot.node.connectedAt,
        cpuCores: snapshot.node.cpu.cores,
        cpuLoadPercent: snapshot.node.cpu.loadPercent,
        id: snapshot.node.id,
        memory: snapshot.node.memory,
        name: snapshot.node.name,
        startedAt: snapshot.node.startedAt,
        storage: snapshot.node.storage,
        uptimeSeconds: snapshot.node.uptimeSeconds,
      },
    })
  }
)

export const getCliServerInfoEffect = Effect.fn("cli.api.servers.info")(
  function* (
    principal: CliPrincipal,
    input: { instanceId: string; relayId: string }
  ) {
    const { instance, relay } = yield* loadAuthorizedInstance(
      principal,
      input,
      "instance.read"
    )
    return cliServerInfoResponseSchema.parse({
      relay: { id: relay.id, name: relay.name },
      server: cliServerMetadata(instance),
    })
  }
)

export const listCliActivityEffect = Effect.fn("cli.api.activity.list")(
  function* (principal: CliPrincipal, limit: number) {
    const activity = yield* Effect.tryPromise({
      try: () => getActivityForUser(principal.user, { limit }),
      catch: (cause) =>
        CliAccessError.make({
          code: "unexpected_error",
          message: "Hearth could not load activity.",
          retryable: false,
          cause,
        }),
    })
    return cliActivityResponse(activity.entries, limit)
  }
)

export const listCliBackupsEffect = Effect.fn("cli.api.backups.list")(
  function* (principal: CliPrincipal, limit: number) {
    const grants = isPlatformAdmin(principal.user)
      ? []
      : yield* listUserGrantsEffect(principal.user.id)
    const catalog = yield* loadCliBackupCatalogEffect()
    const visibleRelayIds = new Set(
      catalog
        .filter((backup) =>
          hasBackupPermission(principal.user, grants, backup, "backup.read")
        )
        .map((backup) => backup.relayId)
    )
    const relays = (yield* listPersistedRelaysEffect()).filter(
      (relay) => relay.enabled && visibleRelayIds.has(relay.id)
    )
    yield* Effect.forEach(
      relays,
      (relay) =>
        Effect.tryPromise({
          try: () => reconcileRelayBackups(relay, cliRelaySubject(principal)),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      { concurrency: 4 }
    )
    const reconciled = yield* loadCliBackupCatalogEffect()
    return cliBackupsResponseSchema.parse({
      backups: reconciled
        .filter((backup) =>
          hasBackupPermission(principal.user, grants, backup, "backup.read")
        )
        .slice(0, limit)
        .map(cliBackupSummary),
    })
  }
)

export const listCliBackupTargetsEffect = Effect.fn("cli.api.backups.targets")(
  function* (principal: CliPrincipal) {
    const [servers, records, relays, grants] = yield* Effect.all(
      [
        listCliServersEffect(principal),
        mapCliBackupFailure(
          listManagedDatabaseRecordsEffect(),
          "Hearth could not inspect managed databases."
        ),
        listPersistedRelaysEffect(),
        isPlatformAdmin(principal.user)
          ? Effect.succeed([])
          : listUserGrantsEffect(principal.user.id),
      ],
      { concurrency: 4 }
    )
    const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
    const enabledRelayIds = new Set(
      relays.filter((relay) => relay.enabled).map((relay) => relay.id)
    )
    const targets = [
      ...servers.servers
        .filter(
          (server) =>
            isPlatformAdmin(principal.user) ||
            grants.some(
              (grant) =>
                grant.relayId === server.relayId &&
                roleHasPermission(grant.role, "backup.create") &&
                (grant.resourceType === "relay" ||
                  (grant.resourceType === "instance" &&
                    grant.resourceId === server.instanceId))
            )
        )
        .map((server) => ({
          kind: "server",
          name: server.name,
          reference: server.id,
          relayName: server.relayName,
        })),
      ...records
        .filter(
          (record) =>
            cliDatabaseSupportsLogicalBackups(record) &&
            enabledRelayIds.has(record.relayId) &&
            (isPlatformAdmin(principal.user) ||
              grants.some(
                (grant) =>
                  grant.relayId === record.relayId &&
                  roleHasPermission(grant.role, "backup.create") &&
                  (grant.resourceType === "relay" ||
                    (grant.resourceType === "database" &&
                      grant.resourceId === record.databaseId))
              ))
        )
        .map((record) => ({
          kind: "database",
          name: record.name,
          reference: `${record.relayId}:${record.databaseId}`,
          relayName: relayNames.get(record.relayId) ?? record.relayId,
        })),
      ...(isPlatformAdmin(principal.user)
        ? relays
            .filter((relay) => relay.enabled)
            .map((relay) => ({
              kind: "platform",
              name: "Kiln platform",
              reference: relay.id,
              relayName: relay.name,
            }))
        : []),
    ]
    return cliBackupTargetsResponseSchema.parse({ targets })
  }
)

export const createCliBackupEffect = Effect.fn("cli.api.backups.create")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliCreateBackupRequestSchema, unknownInput)
    const relay = yield* authorizeCliBackupCreateTarget(principal, input)
    yield* validateCliBackupStorage(principal, input)
    const backupId = randomUUID()
    const taskId = randomUUID()
    const common = {
      backupId,
      createdBy: principal.user.id,
      name: input.name,
      relayId: relay.id,
      requestedMaxBytes: null,
      ...(input.storageId === undefined ? {} : { storageId: input.storageId }),
      taskId,
    }
    const dispatch = yield* mapCliBackupFailure(
      input.targetKind === "instance"
        ? reserveInstanceBackupEffect({
            ...common,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            targetId: input.targetId,
          })
        : input.targetKind === "database"
          ? reserveDatabaseBackupEffect({
              ...common,
              targetId: input.targetId,
            })
          : reservePlatformBackupEffect({
              ...common,
              targetId: kilnInstallationId(),
            }),
      "Hearth could not reserve the backup."
    )
    const relayAccepted = yield* enqueueCliBackupEffect(
      principal,
      relay,
      dispatch
    )
    return cliBackupMutationResponseSchema.parse({
      backupId,
      relayAccepted,
      taskId,
    })
  }
)

export const restoreCliBackupEffect = Effect.fn("cli.api.backups.restore")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliRestoreBackupRequestSchema, unknownInput)
    const { backup } = yield* loadCliBackupForAction(
      principal,
      input.backupId,
      "backup.restore"
    )
    if (
      backup.status !== "available" ||
      (backup.targetKind !== "instance" && backup.targetKind !== "database") ||
      (backup.targetKind === "instance" &&
        !(
          (backup.artifactKind === "archive" && backup.backupMode === "full") ||
          (backup.artifactKind === "restic_snapshot" &&
            backup.backupMode === "incremental")
        )) ||
      (backup.targetKind === "database" &&
        (backup.artifactKind !== "database_dump" ||
          backup.backupMode !== "full"))
    ) {
      return yield* cliConflict(
        "Only complete server or database backups can be restored."
      )
    }
    const relay = yield* requiredRelay(backup.relayId)
    if (input.safetyBackup) {
      yield* requireCliBackupPermission(principal, backup, "backup.create")
    }
    if (backup.targetKind === "instance") {
      const snapshot = yield* relayRpcEffect(
        relay,
        "relay.snapshot",
        {},
        principal
      ).pipe(Effect.flatMap(parseRelaySnapshot))
      const instance = snapshot.instances.find(
        (candidate) => candidate.id === backup.targetId
      )
      if (!instance)
        return yield* cliNotFound("The restore target was not found.")
      if (
        instance.observedState !== "stopped" ||
        instance.desiredState !== "stopped"
      ) {
        return yield* cliConflict(
          "Stop the server before restoring its backup."
        )
      }
    } else {
      const records = yield* mapCliBackupFailure(
        listManagedDatabaseRecordsEffect(),
        "Hearth could not inspect managed databases."
      )
      if (
        !records.some(
          (record) =>
            record.relayId === relay.id && record.databaseId === backup.targetId
        )
      ) {
        return yield* cliNotFound("The restore target was not found.")
      }
    }
    const safety = input.safetyBackup
      ? yield* mapCliBackupFailure(
          backup.targetKind === "instance"
            ? reserveInstanceBackupEffect({
                backupId: randomUUID(),
                createdBy: principal.user.id,
                name: `Before restoring ${backup.name}`.slice(0, 120),
                reason: "pre_restore",
                relayId: relay.id,
                requestedMaxBytes: null,
                targetId: backup.targetId,
                taskId: randomUUID(),
              })
            : reserveDatabaseBackupEffect({
                backupId: randomUUID(),
                createdBy: principal.user.id,
                name: `Before restoring ${backup.name}`.slice(0, 120),
                reason: "pre_restore",
                relayId: relay.id,
                requestedMaxBytes: null,
                targetId: backup.targetId,
                taskId: randomUUID(),
              }),
          "Hearth could not reserve the safety backup."
        )
      : null
    const restore = yield* mapCliBackupFailure(
      reserveBackupRestoreEffect({
        backupId: backup.id,
        dependsOnTaskId: safety?.taskId ?? null,
        requestedBy: principal.user.id,
        taskId: randomUUID(),
      }),
      "Hearth could not reserve the restore."
    )
    const relayAccepted = yield* enqueueCliBackupEffect(
      principal,
      relay,
      safety ?? restore
    )
    if (safety && relayAccepted) {
      scheduleBackupReconciliation(relay, cliRelaySubject(principal))
    }
    return cliRestoreBackupResponseSchema.parse({
      relayAccepted,
      restoreTaskId: restore.taskId,
      safetyBackupId: safety?.backupId ?? null,
    })
  }
)

export const deleteCliBackupEffect = Effect.fn("cli.api.backups.delete")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliDeleteBackupRequestSchema, unknownInput)
    if (input.confirmation !== input.backupId) {
      return yield* forbidden(
        "The backup confirmation did not match the requested backup."
      )
    }
    const { backup } = yield* loadCliBackupForAction(
      principal,
      input.backupId,
      "backup.delete"
    )
    const relay = yield* requiredRelay(backup.relayId)
    const dispatch = yield* mapCliBackupFailure(
      reserveBackupDeleteEffect({
        backupId: backup.id,
        requestedBy: principal.user.id,
        taskId: randomUUID(),
      }),
      "Hearth could not reserve backup deletion."
    )
    const relayAccepted = yield* enqueueCliBackupEffect(
      principal,
      relay,
      dispatch
    )
    return cliDeleteBackupResponseSchema.parse({
      backupId: backup.id,
      relayAccepted,
    })
  }
)

export const getCliBackupDownloadEffect = Effect.fn("cli.api.backups.download")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    const input = yield* parseInput(
      cliBackupDownloadRequestSchema,
      unknownInput
    )
    const { backup } = yield* loadCliBackupForAction(
      principal,
      input.backupId,
      "backup.download"
    )
    const artifact =
      backup.artifacts.find(
        (candidate) =>
          candidate.status === "available" && candidate.storageId === null
      ) ??
      backup.artifacts.find((candidate) => candidate.status === "available")
    if (backup.status !== "available" || !artifact) {
      return yield* cliConflict("The backup is not available for download.")
    }
    if (backup.artifactKind === "restic_snapshot") {
      const reserved = yield* mapCliBackupFailure(
        reserveBackupExportEffect({
          backupId: backup.id,
          replaceFailed: !input.poll,
          requestedBy: principal.user.id,
          requireFullTtl: !input.poll,
          taskId: randomUUID(),
          ttlMs: 300_000,
        }),
        "Hearth could not prepare the snapshot export."
      )
      if (reserved.kind === "dispatch") {
        const relay = yield* requiredRelay(backup.relayId)
        yield* enqueueCliBackupEffect(principal, relay, reserved.dispatch)
        return cliBackupDownloadResponseSchema.parse({
          status: "preparing",
          taskId: reserved.dispatch.taskId,
        })
      }
      const remainingSeconds = Math.max(
        1,
        Math.min(300, Math.floor((reserved.expiresAt - Date.now()) / 1_000))
      )
      const relay = yield* requiredRelay(backup.relayId)
      const signed = yield* Effect.tryPromise({
        try: () =>
          signLocalBackupDownload(
            relay,
            backup,
            reserved.filename,
            cliRelaySubject(principal),
            remainingSeconds
          ),
        catch: (cause) =>
          CliAccessError.make({
            code: "relay_unavailable",
            message: "Hearth could not sign the Relay download.",
            retryable: true,
            cause,
          }),
      })
      return cliBackupDownloadResponseSchema.parse({
        ...signed,
        filename: reserved.filename,
        status: "ready",
      })
    }
    const filename = artifact.filename ?? backup.filename
    if (!filename) {
      return yield* cliConflict("The backup is not available for download.")
    }
    if (!artifact.storageId) {
      if (artifact.objectKey) {
        return yield* cliConflict("The local backup metadata is invalid.")
      }
      const relay = yield* requiredRelay(backup.relayId)
      const signed = yield* Effect.tryPromise({
        try: () =>
          signLocalBackupDownload(
            relay,
            backup,
            filename,
            cliRelaySubject(principal),
            300
          ),
        catch: (cause) =>
          CliAccessError.make({
            code: "relay_unavailable",
            message: "Hearth could not sign the Relay download.",
            retryable: true,
            cause,
          }),
      })
      return cliBackupDownloadResponseSchema.parse({
        ...signed,
        filename,
        status: "ready",
      })
    }
    if (!artifact.objectKey) {
      return yield* cliConflict("The S3 backup metadata is invalid.")
    }
    const objectKey = artifact.objectKey
    const storage = yield* mapCliBackupFailure(
      loadBackupStorageCredentialEffect(artifact.storageId),
      "Hearth could not load the backup destination."
    )
    if (!storage)
      return yield* cliNotFound("The backup destination was not found.")
    const signed = yield* mapCliBackupFailure(
      signS3BackupDownload(storage, objectKey, filename, 300),
      "Hearth could not sign the S3 download."
    )
    return cliBackupDownloadResponseSchema.parse({
      ...signed,
      filename,
      status: "ready",
    })
  }
)

export const createCliServerEffect = Effect.fn("cli.api.servers.create")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliCreateServerRequestSchema, unknownInput)
    const relay = yield* requiredRelay(input.relayId)
    if (!canCreateCliServer(principal.user, relay)) {
      return yield* forbidden(
        "You can only create servers on Relays you manage."
      )
    }
    const brick = yield* resolveBrickSource(input.brick, principal)
    const result = yield* relayRpcEffect(
      relay,
      "instance.create",
      {
        diskLimitBytes: input.diskLimitBytes,
        name: input.name,
        recipe: brick.source,
        ...(brick.recipeDefinition
          ? { recipeDefinition: brick.recipeDefinition }
          : {}),
        start: input.start,
        variables: input.variables,
      },
      principal,
      360_000
    )
    const instance = relayInstanceSchema.parse(result)
    yield* invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
    yield* Effect.tryPromise({
      try: () => provisionInstanceDomainBestEffort(instance, relay.id),
      catch: () => undefined,
    }).pipe(Effect.ignore)
    return cliServerMutationResponseSchema.parse({
      relayId: relay.id,
      server: cliServerMetadata(instance),
    })
  }
)

export function canCreateCliServer(
  user: CliPrincipal["user"],
  relay: Pick<PersistedRelay, "createdBy">
): boolean {
  return (
    isPlatformAdmin(user) ||
    (isRelayCreator(user) && relay.createdBy === user.id)
  )
}

export const updateCliServerStartupEffect = Effect.fn(
  "cli.api.servers.startup.update"
)(function* (principal: CliPrincipal, unknownInput: unknown) {
  yield* requireCliWrite(principal)
  const input = yield* parseInput(
    cliUpdateServerStartupRequestSchema,
    unknownInput
  )
  const { instance, relay } = yield* loadAuthorizedInstance(
    principal,
    input,
    "instance.settings"
  )
  const brick = input.brick
    ? yield* resolveBrickSource(input.brick, principal)
    : undefined
  const variables = brick
    ? input.variables
    : { ...instance.variables, ...input.variables }
  const result = yield* relayRpcEffect(
    relay,
    "instance.startup.write",
    {
      ...(input.diskLimitBytes === undefined
        ? {}
        : { diskLimitBytes: input.diskLimitBytes }),
      instanceId: instance.id,
      ...(brick
        ? {
            recipe: brick.source,
            ...(brick.recipeDefinition
              ? { recipeDefinition: brick.recipeDefinition }
              : {}),
          }
        : {}),
      start: input.start,
      variables,
    },
    principal,
    360_000
  )
  const updated = relayInstanceSchema.parse(result)
  yield* invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
  yield* Effect.tryPromise({
    try: () => provisionInstanceDomainBestEffort(updated, relay.id),
    catch: () => undefined,
  }).pipe(Effect.ignore)
  return cliServerMutationResponseSchema.parse({
    relayId: relay.id,
    server: cliServerMetadata(updated),
  })
})

export const deleteCliServerEffect = Effect.fn("cli.api.servers.delete")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliDeleteServerRequestSchema, unknownInput)
    if (input.confirmation !== `${input.relayId}:${input.instanceId}`) {
      return yield* forbidden(
        "The server confirmation did not match the requested server."
      )
    }
    const relay = yield* authorizeTarget(principal, input, "instance.delete")
    yield* Effect.tryPromise({
      try: () =>
        deleteInstanceWithFinalBackup({
          instanceId: input.instanceId,
          relay,
          requestedBy: principal.user.id,
        }),
      catch: (cause) => cause,
    })
    const deleted = { deleted: true as const, instanceId: input.instanceId }
    return { ...deleted, relayId: relay.id }
  }
)

export const uploadCliFileFromUrlEffect = Effect.fn("cli.api.files.uploadUrl")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(
      cliRemoteFileUploadRequestSchema,
      unknownInput
    )
    const relay = yield* authorizeTarget(
      principal,
      input,
      "instance.files.write"
    )
    const result = yield* relayRpcEffect(
      relay,
      "instance.files.upload-url",
      relayRemoteUploadInput(input),
      principal,
      360_000
    )
    const uploaded = cliRemoteFileUploadResponseSchema.parse(
      relayRemoteFileUploadResultSchema.parse(result)
    )
    yield* invalidateRelayCache(
      relayCachePolicy.tree(relay.id, input.instanceId)
    )
    return uploaded
  }
)

export function cliActivityResponse(
  entries: ReadonlyArray<Readonly<Record<string, unknown>>>,
  limit: number
) {
  const safeEntries = entries.slice(0, limit).map((entry) => {
    const { rawEvent, ...safeEntry } = entry
    void rawEvent
    return safeEntry
  })
  return cliActivityResponseSchema.parse({ entries: safeEntries })
}

export function relayRemoteUploadInput(
  input: z.infer<typeof cliRemoteFileUploadRequestSchema>
) {
  return relayRemoteFileUploadSchema.parse({
    instanceId: input.instanceId,
    path: input.path,
    url: input.url,
  })
}

export function cliPowerResponse(
  action: z.infer<typeof cliPowerRequestSchema>["action"],
  instance: Pick<
    z.infer<typeof relayInstanceSchema>,
    "desiredState" | "id" | "name" | "observedState"
  >,
  relayId: string
) {
  return cliPowerResponseSchema.parse({
    action,
    instance: {
      desiredState: instance.desiredState,
      id: instance.id,
      name: instance.name,
      observedState: instance.observedState,
    },
    relayId,
  })
}

export const performCliPowerActionEffect = Effect.fn("cli.api.power")(
  function* (principal: CliPrincipal, unknownInput: unknown) {
    yield* requireCliWrite(principal)
    const input = yield* parseInput(cliPowerRequestSchema, unknownInput)
    const relay = yield* authorizeTarget(principal, input, "instance.power")
    const result = yield* relayRpcEffect(
      relay,
      "instance.action",
      { action: input.action, instanceId: input.instanceId },
      principal,
      CLI_RELAY_LONG_OPERATION_TIMEOUT_MS
    )
    return cliPowerResponse(
      input.action,
      relayInstanceSchema.parse(result),
      relay.id
    )
  }
)

export const sendCliConsoleCommandEffect = Effect.fn("cli.api.console.write")(
  function* (
    principal: CliPrincipal,
    input: { command: string; instanceId: string; relayId: string }
  ) {
    yield* requireCliWrite(principal)
    const relay = yield* authorizeTarget(
      principal,
      input,
      "instance.console.write"
    )
    const result = yield* relayRpcEffect(
      relay,
      "instance.console.write",
      { command: input.command, instanceId: input.instanceId },
      principal,
      undefined,
      cliConsoleRelayFailure
    )
    return relayConsoleCommandResultSchema.parse(result)
  }
)

export const getCliConsoleHistoryEffect = Effect.fn("cli.api.console.history")(
  function* (
    principal: CliPrincipal,
    input: { instanceId: string; limit: number; relayId: string }
  ) {
    const relay = yield* authorizeTarget(
      principal,
      input,
      "instance.console.read"
    )
    const result = yield* relayRpcEffect(
      relay,
      "instance.console.history",
      { instanceId: input.instanceId, limit: input.limit },
      principal
    )
    return relayConsoleSchema.parse(result)
  }
)

export const authorizeCliConsoleStreamEffect = Effect.fn(
  "cli.api.console.stream.authorize"
)(function* (
  principal: CliPrincipal,
  input: { instanceId: string; relayId: string }
) {
  yield* authorizeTarget(principal, input, "instance.console.read")
})

export const getCliFileTreeEffect = Effect.fn("cli.api.files.list")(function* (
  principal: CliPrincipal,
  unknownInput: unknown
) {
  const input = yield* parseInput(cliFileTargetSchema, unknownInput)
  const relay = yield* authorizeTarget(principal, input, "instance.files.read")
  const result = yield* relayRpcEffect(
    relay,
    "instance.files.list",
    { instanceId: input.instanceId },
    principal
  )
  const tree = relayFileTreeSchema.parse(result)
  const prefix = input.path === "." ? "" : input.path.replace(/\/$/u, "")
  return {
    ...tree,
    paths: prefix
      ? tree.paths.filter(
          (path) => path === prefix || path.startsWith(`${prefix}/`)
        )
      : tree.paths,
  }
})

export const readCliFileEffect = Effect.fn("cli.api.files.read")(function* (
  principal: CliPrincipal,
  unknownInput: unknown
) {
  const input = yield* parseInput(cliFileTargetSchema, unknownInput)
  const relay = yield* authorizeTarget(principal, input, "instance.files.read")
  const result = yield* relayRpcEffect(
    relay,
    "instance.files.read",
    { instanceId: input.instanceId, path: input.path },
    principal
  )
  return relayFileContentSchema.parse(result)
})

export const writeCliFileEffect = Effect.fn("cli.api.files.write")(function* (
  principal: CliPrincipal,
  unknownInput: unknown
) {
  yield* requireCliWrite(principal)
  const input = yield* parseInput(cliFileWriteRequestSchema, unknownInput)
  const relay = yield* authorizeTarget(principal, input, "instance.files.write")
  const result = yield* relayRpcEffect(
    relay,
    "instance.files.write",
    {
      content: input.content,
      expectedModifiedAt: input.expectedModifiedAt,
      instanceId: input.instanceId,
      path: input.path,
    },
    principal,
    CLI_RELAY_LONG_OPERATION_TIMEOUT_MS
  )
  return relayFileContentSchema.parse(result)
})

export const getCliSftpConnectionEffect = Effect.fn("cli.api.sftp")(function* (
  principal: CliPrincipal,
  input: { instanceId: string; relayId: string }
) {
  const relay = yield* authorizeTarget(
    principal,
    input,
    "instance.sftp.connect"
  )
  const value = yield* relayRpcEffect(relay, "relay.snapshot", {}, principal)
  const snapshot = yield* parseRelaySnapshot(value)
  const exists = snapshot.instances.some(
    (instance) => instance.id === input.instanceId
  )
  if (!exists || !snapshot.relay?.sftp) {
    return yield* CliAccessError.make({
      code: "sftp_unavailable",
      message: "SFTP is not configured for this server's Relay.",
      retryable: false,
    })
  }
  const unavailableMessage = cliSftpUnavailableMessage(snapshot.relay.sftp)
  if (unavailableMessage) {
    return yield* CliAccessError.make({
      code: "sftp_unavailable",
      message: unavailableMessage,
      retryable: false,
    })
  }
  return cliSftpConnectionResponse(
    snapshot.relay.sftp,
    input.instanceId,
    principal.user.email
  )
})

export function cliSftpUnavailableMessage(
  connection: RelaySftpConnection
): string | null {
  if (connection.publication === "not_published") {
    return `Relay SFTP port ${connection.port}/tcp is not published by Docker. Publish the port and retry.`
  }
  return null
}

export function cliSftpConnectionResponse(
  connection: RelaySftpConnection,
  instanceId: string,
  username: string
) {
  return cliSftpResponseSchema.parse({
    host: connection.host,
    hostKeyFingerprint: connection.hostKeyFingerprint,
    port: connection.port,
    root: `/${instanceId}`,
    username,
  })
}

const loadCliBackupCatalogEffect = Effect.fn("cli.api.backups.catalog")(
  function* () {
    return yield* mapCliBackupFailure(
      listBackupCatalogEffect(),
      "Hearth could not load backups."
    )
  }
)

const authorizeCliBackupCreateTarget = Effect.fn(
  "cli.api.backups.create.authorize"
)(function* (
  principal: CliPrincipal,
  input: z.infer<typeof cliCreateBackupRequestSchema>
) {
  if (input.targetKind === "platform") {
    if (!isPlatformAdmin(principal.user)) {
      return yield* forbidden(
        "Platform backups require platform administrator access."
      )
    }
    return yield* requiredRelay(input.relayId)
  }
  if (input.targetKind === "instance") {
    const { relay } = yield* loadAuthorizedInstance(
      principal,
      { instanceId: input.targetId, relayId: input.relayId },
      "backup.create"
    )
    return relay
  }
  const relay = yield* requiredRelay(input.relayId)
  yield* requireRelayPermissionEffect({
    databaseId: input.targetId,
    permission: "backup.create",
    relayId: relay.id,
    user: principal.user,
  }).pipe(
    Effect.catchTag("PermissionDeniedError", (cause) =>
      CliAccessError.make({
        code: "forbidden",
        message: cause.message,
        retryable: false,
      })
    )
  )
  const records = yield* mapCliBackupFailure(
    listManagedDatabaseRecordsEffect(),
    "Hearth could not inspect managed databases."
  )
  const database = records.find(
    (record) =>
      record.relayId === relay.id && record.databaseId === input.targetId
  )
  if (!database) {
    return yield* cliNotFound("The requested database was not found.")
  }
  if (!cliDatabaseSupportsLogicalBackups(database)) {
    return yield* cliConflict(
      `${database.engine} logical backups are not supported yet`
    )
  }
  return relay
})

export function cliDatabaseSupportsLogicalBackups(database: {
  engine: Parameters<typeof databaseEngineSupportsLogicalBackups>[0]
}): boolean {
  return databaseEngineSupportsLogicalBackups(database.engine)
}

const validateCliBackupStorage = Effect.fn("cli.api.backups.storage.authorize")(
  function* (
    principal: CliPrincipal,
    input: z.infer<typeof cliCreateBackupRequestSchema>
  ) {
    if (!input.storageId) return
    const storage = yield* mapCliBackupFailure(
      loadBackupStorageEffect(input.storageId),
      "Hearth could not load the backup destination."
    )
    if (
      !storage ||
      !storage.enabled ||
      storage.deleting ||
      (input.targetKind === "platform"
        ? storage.ownerUserId !== null
        : storage.ownerUserId !== null &&
          storage.ownerUserId !== principal.user.id)
    ) {
      return yield* forbidden("The backup destination is unavailable.")
    }
  }
)

const loadCliBackupForAction = Effect.fn("cli.api.backups.action.authorize")(
  function* (
    principal: CliPrincipal,
    backupId: string,
    permission: AccessPermission
  ) {
    const backup = (yield* loadCliBackupCatalogEffect()).find(
      (candidate) => candidate.id === backupId
    )
    if (!backup)
      return yield* cliNotFound("The requested backup was not found.")
    const grants = isPlatformAdmin(principal.user)
      ? []
      : yield* listUserGrantsEffect(principal.user.id)
    if (!hasBackupPermission(principal.user, grants, backup, permission)) {
      return yield* forbidden(
        "You do not have permission to manage this backup."
      )
    }
    return { backup }
  }
)

const requireCliBackupPermission = Effect.fn(
  "cli.api.backups.target.authorize"
)(function* (
  principal: CliPrincipal,
  backup: BackupCatalogRecord,
  permission: AccessPermission
) {
  yield* requireRelayPermissionEffect({
    ...(backup.targetKind === "instance"
      ? { instanceId: backup.targetId }
      : { databaseId: backup.targetId }),
    permission,
    relayId: backup.relayId,
    user: principal.user,
  }).pipe(
    Effect.catchTag("PermissionDeniedError", (cause) =>
      CliAccessError.make({
        code: "forbidden",
        message: cause.message,
        retryable: false,
      })
    )
  )
})

const enqueueCliBackupEffect = Effect.fn("cli.api.backups.enqueue")(function* (
  principal: CliPrincipal,
  relay: PersistedRelay,
  dispatch: BackupDispatch
) {
  const result = yield* Effect.result(
    Effect.tryPromise({
      try: () =>
        dispatchBackupTask(relay, dispatch, cliRelaySubject(principal)),
      catch: (cause) =>
        CliAccessError.make({
          code: "relay_unavailable",
          message: "The backup was saved but Relay did not accept it yet.",
          retryable: true,
          cause,
        }),
    })
  )
  return Result.isSuccess(result)
})

function mapCliBackupFailure<TResult, TError, TRequirements>(
  effect: Effect.Effect<TResult, TError, TRequirements>,
  fallbackMessage: string
) {
  return effect.pipe(
    Effect.mapError((cause) =>
      CliAccessError.make({
        code: "conflict",
        message: cause instanceof Error ? cause.message : fallbackMessage,
        retryable: false,
        cause,
      })
    )
  )
}

function cliBackupSummary(backup: BackupCatalogRecord) {
  return {
    artifactKind: backup.artifactKind,
    backupMode: backup.backupMode,
    bytes: backup.bytes,
    createdAt: backup.createdAt,
    destinations: [
      ...new Set(
        backup.artifacts.map((artifact) =>
          artifact.storageId ? ("s3" as const) : ("local" as const)
        )
      ),
    ],
    filename: backup.filename,
    id: backup.id,
    name: backup.name,
    relayId: backup.relayId,
    status: backup.status,
    targetId: backup.targetId,
    targetKind: backup.targetKind,
    taskError: backup.taskError,
    taskStatus: backup.taskStatus,
  }
}

function cliConflict(message: string) {
  return CliAccessError.make({
    code: "conflict",
    message,
    retryable: false,
  })
}

function cliNotFound(message: string) {
  return CliAccessError.make({
    code: "not_found",
    message,
    retryable: false,
  })
}

const authorizeTarget = Effect.fn("cli.api.target.authorize")(function* (
  principal: CliPrincipal,
  input: { instanceId: string; relayId: string },
  permission: AccessPermission
) {
  const relay = yield* requiredRelay(input.relayId)
  yield* requireRelayPermissionEffect({
    instanceId: input.instanceId,
    permission,
    relayId: relay.id,
    user: principal.user,
  }).pipe(
    Effect.catchTag("PermissionDeniedError", (cause) =>
      CliAccessError.make({
        code: "forbidden",
        message: cause.message,
        retryable: false,
      })
    )
  )
  return relay
})

const authorizeRelay = Effect.fn("cli.api.relay.authorize")(function* (
  principal: CliPrincipal,
  relayId: string,
  permission: AccessPermission
) {
  const relay = yield* requiredRelay(relayId)
  yield* requireRelayPermissionEffect({
    permission,
    relayId: relay.id,
    user: principal.user,
  }).pipe(
    Effect.catchTag("PermissionDeniedError", (cause) =>
      CliAccessError.make({
        code: "forbidden",
        message: cause.message,
        retryable: false,
      })
    )
  )
  return relay
})

const requiredRelay = Effect.fn("cli.api.relay.required")(function* (
  relayId: string
) {
  const relays = yield* listPersistedRelaysEffect()
  const relay = relays.find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (!relay) {
    return yield* CliAccessError.make({
      code: "not_found",
      message: "The requested Relay was not found.",
      retryable: false,
    })
  }
  return relay
})

const loadAuthorizedInstance = Effect.fn("cli.api.instance.load")(function* (
  principal: CliPrincipal,
  input: { instanceId: string; relayId: string },
  permission: AccessPermission
) {
  const relay = yield* authorizeTarget(principal, input, permission)
  const snapshot = yield* relayRpcEffect(
    relay,
    "relay.snapshot",
    {},
    principal
  ).pipe(Effect.flatMap(parseRelaySnapshot))
  const instance = snapshot.instances.find(
    (candidate) => candidate.id === input.instanceId
  )
  if (!instance) {
    return yield* CliAccessError.make({
      code: "not_found",
      message: "The requested server was not found.",
      retryable: false,
    })
  }
  return { instance, relay }
})

const resolveBrickSource = Effect.fn("cli.api.brick.resolve")(function* (
  brick: string,
  principal: CliPrincipal
) {
  if (/^https:\/\//iu.test(brick)) {
    if (!hasPlatformPermission(principal.user, "platform.bricks.add-custom")) {
      return yield* CliAccessError.make({
        code: "forbidden",
        message: "Custom Bricks require Bring your own Relay access.",
        retryable: false,
      })
    }
    return { source: brick }
  }
  const catalogs = yield* Effect.tryPromise({
    try: () => visibleBrickCatalogs(principal.user),
    catch: (cause) =>
      CliAccessError.make({
        code: "unexpected_error",
        message: "Hearth could not load the Brick catalogs.",
        retryable: true,
        cause,
      }),
  })
  const matches = catalogs.flatMap((catalog) =>
    catalog.bricks.filter((candidate) => candidate.metadata.id === brick)
  )
  if (matches.length === 0) {
    return yield* CliAccessError.make({
      code: "not_found",
      message: `Brick ${brick} is not available in your Hearth catalogs.`,
      retryable: false,
    })
  }
  if (matches.length > 1) {
    return yield* CliAccessError.make({
      code: "conflict",
      message: `Brick ${brick} is provided by more than one catalog. Use its HTTPS recipe URL.`,
      retryable: false,
    })
  }
  const selected = matches[0]!
  const { source, ...recipeDefinition } = selected
  return { recipeDefinition, source }
})

function cliRelaySummary(
  relay: PersistedRelay,
  snapshot: z.infer<typeof relaySnapshotSchema> | null
) {
  return cliRelaySchema.parse({
    arch: snapshot?.node.arch ?? relay.nodeArch,
    canProvisionServers: snapshot?.node.canProvisionInstances ?? null,
    id: relay.id,
    name: relay.name,
    platform: snapshot?.node.platform ?? relay.nodePlatform,
    serverCount: snapshot?.instances.length ?? null,
    status: snapshot ? "connected" : "unreachable",
    version: snapshot?.node.version ?? relay.nodeVersion,
  })
}

function cliServerMetadata(instance: z.infer<typeof relayInstanceSchema>) {
  return {
    brickId: instance.brickId ?? null,
    brickSource: safeCliBrickSource(instance.brickSource),
    connectAddress: instance.connectAddress,
    desiredState: instance.desiredState,
    diskLimitBytes: instance.limits.diskBytes,
    game: instance.game,
    id: instance.id,
    implementation: instance.implementation,
    javaVersion: instance.javaVersion,
    memoryLimitBytes: instance.limits.memoryBytes,
    name: instance.name,
    observedState: instance.observedState,
    stateReason: instance.stateReason,
    publicAddress:
      instance.publicHost && instance.publicPort
        ? `${instance.publicHost}:${instance.publicPort}`
        : null,
    readyAt:
      instance.lifecycle.find((event) => event.state === "ready")?.time ?? null,
    resources: instance.resources
      ? {
          cpuPercent: instance.resources.cpu.percent,
          memoryUsedBytes: instance.resources.memory.usedBytes,
          networkReceivedBytes:
            instance.resources.network?.receivedBytes ?? null,
          networkSentBytes: instance.resources.network?.sentBytes ?? null,
          sampledAt: instance.resources.sampledAt,
          storageUsedBytes: instance.resources.storage.usedBytes,
        }
      : null,
    shortId: instance.shortId,
    startedAt: instance.startedAt,
    version: instance.version,
  }
}

export function safeCliBrickSource(source: string | undefined): string | null {
  if (!source) return null
  return Result.try(() => {
    const url = new URL(source)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href
  }).pipe(Result.getOrNull)
}

function forbidden(message: string) {
  return CliAccessError.make({
    code: "forbidden",
    message,
    retryable: false,
  })
}

function relayRpcEffect(
  relay: PersistedRelay,
  operation: Parameters<typeof relayRpc>[1],
  payload: unknown,
  principal: CliPrincipal,
  timeoutMs?: number,
  onFailure: (cause: unknown) => CliAccessError = relayUnavailableFailure
) {
  return Effect.tryPromise({
    try: () =>
      relayRpc(
        relay,
        operation,
        payload,
        timeoutMs,
        cliRelaySubject(principal)
      ),
    catch: onFailure,
  })
}

function relayUnavailableFailure(cause: unknown): CliAccessError {
  return CliAccessError.make({
    code: "relay_unavailable",
    message:
      cause instanceof Error
        ? cause.message
        : "Hearth could not reach the Relay.",
    retryable: true,
    cause,
  })
}

export function cliConsoleRelayFailure(cause: unknown): CliAccessError {
  if (!(cause instanceof RelayUnavailableError) || !cause.code) {
    return relayUnavailableFailure(cause)
  }
  return CliAccessError.make({
    code: "relay_operation_failed",
    detail: cause.message,
    message: "Relay could not send the console command.",
    ...(cause.requestId ? { requestId: cause.requestId } : {}),
    retryable: cause.retryable ?? false,
    cause,
  })
}

function parseRelaySnapshot(value: unknown) {
  return Effect.try({
    try: () => relaySnapshotSchema.parse(value),
    catch: (cause) =>
      CliAccessError.make({
        code: "relay_unavailable",
        message: "The Relay returned an invalid snapshot.",
        retryable: true,
        cause,
      }),
  })
}

function parseInput<TValue>(schema: z.ZodType<TValue>, value: unknown) {
  return Effect.try({
    try: () => schema.parse(value),
    catch: (cause) =>
      CliAccessError.make({
        code: "invalid_request",
        message: "The CLI request contains invalid input.",
        retryable: false,
        cause,
      }),
  })
}
