import { Effect } from "effect"

import {
  getBackupCatalogRecordEffect,
  getBackupForTaskEffect,
} from "@/effect/backups"
import { promiseEffect } from "@/effect/promise"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hasBackupPermission } from "@/lib/backup-access"
import {
  backupKey,
  backupStorageKey,
  backupTargetKey,
} from "@/lib/backup-lanes"
import { resolveBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import type { BackupCatalogRecord } from "@/effect/backups"
import { exclusive, shared, type LaneLock } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  createAppBackupsHandler,
  resolveUnfinishedRestoreHandler,
} from "@/server/app-backups.server"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import {
  createDatabaseBackupHandler,
  createInstanceBackupHandler,
  createPlatformBackupHandler,
  createResourceBackupHandler,
  restoreDatabaseBackupHandler,
  restoreInstanceBackupHandler,
  restoreResourceBackupHandler,
} from "@/server/backups.server"
import type {
  BackupRestoreInput,
  DatabaseBackupInput,
  InstanceBackupInput,
  PlatformBackupInput,
  ResourceBackupInput,
} from "@/server/backups"

// Backups and restores as operations (docs/hearth-operations.md). Each holds
// what it backs up or restores while Hearth reserves it and hands it to the
// Relay, which runs it in its own lanes. Before any lane is taken, each
// checks the person may do it, so a refusal tells nothing to one who may
// not, and settles the destinations it reserves to, so those it holds are
// the ones it uses.

// Each destination a backup is reserved to, so it isn't changed or deleted
// meanwhile. The Relay's own storage is none.
const destinations = (
  storageIds: ReadonlyArray<string | null> | undefined
): Array<LaneLock> =>
  [...new Set(storageIds ?? [])].flatMap((id) =>
    id ? [shared(backupStorageKey(id))] : []
  )

const permitted = (
  user: AuthenticatedUser | null,
  check: (person: AuthenticatedUser) => Promise<void>
) =>
  signedIn(user).pipe(
    Effect.tap((person) => promiseEffect(() => check(person)))
  )

export const backUpInstance = operation<InstanceBackupInput>()({
  name: "backup.instance.create",
  doing: "Backing up this game server",
  authorize: ({ input, user }) =>
    permitted(user, (person) =>
      requireRelayPermission({
        instanceId: input.instanceId,
        permission: "backup.create",
        relayId: input.relayId,
        user: person,
      })
    ).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => ({
          storageIds: await resolveBackupStorageSelection({
            ...input,
            targetId: input.instanceId,
            targetKind: "instance",
          }),
          user: person,
        }))
      )
    ),
  locks: ({ context, input }) => [
    shared(
      backupTargetKey(input.relayId, { id: input.instanceId, kind: "instance" })
    ),
    ...destinations(context.storageIds),
  ],
  run: ({ context, input }) =>
    promiseEffect(() =>
      createInstanceBackupHandler(context.user, {
        ...input,
        storageId: undefined,
        storageIds: context.storageIds,
      })
    ),
  audit: ({ input }) => ({
    id: input.instanceId,
    kind: "instance",
    relayId: input.relayId,
  }),
})

export const backUpDatabase = operation<DatabaseBackupInput>()({
  name: "backup.database.create",
  doing: "Backing up this database",
  authorize: ({ input, user }) =>
    permitted(user, (person) =>
      requireRelayPermission({
        databaseId: input.databaseId,
        permission: "backup.create",
        relayId: input.relayId,
        user: person,
      })
    ).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => ({
          storageIds: await resolveBackupStorageSelection({
            ...input,
            targetId: input.databaseId,
            targetKind: "database",
          }),
          user: person,
        }))
      )
    ),
  locks: ({ context, input }) => [
    shared(
      backupTargetKey(input.relayId, { id: input.databaseId, kind: "database" })
    ),
    ...destinations(context.storageIds),
  ],
  run: ({ context, input }) =>
    promiseEffect(() =>
      createDatabaseBackupHandler(context.user, {
        ...input,
        storageId: undefined,
        storageIds: context.storageIds,
      })
    ),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
})

// An App's folder or a volume.
export const backUpResource = operation<ResourceBackupInput>()({
  name: "backup.resource.create",
  doing: (input) =>
    input.target.kind === "app"
      ? "Backing up this App's folder"
      : "Backing up this volume",
  authorize: ({ input, user }) =>
    permitted(user, (person) =>
      requireBackupTargetPermission(
        person,
        input.relayId,
        input.target,
        "backup.create"
      )
    ).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => ({
          storageIds: await resolveBackupStorageSelection({
            ...input,
            targetId: input.target.id,
            targetKind: input.target.kind,
          }),
          user: person,
        }))
      )
    ),
  locks: ({ context, input }) => [
    shared(backupTargetKey(input.relayId, input.target)),
    ...destinations(context.storageIds),
  ],
  run: ({ context, input }) =>
    promiseEffect(() =>
      createResourceBackupHandler(context.user, {
        ...input,
        storageId: undefined,
        storageIds: context.storageIds,
      })
    ),
  audit: ({ input }) => ({
    id: input.target.id,
    kind: input.target.kind,
    relayId: input.relayId,
  }),
})

// An App's folder and the volumes it owns, together. Each settles its own
// destination unless one was chosen for all.
export const backUpApp = operation<{
  appId: string
  consistency: "live" | "stopped"
  name: string
  relayId: string
  storageIds?: Array<string | null> | undefined
}>()({
  name: "backup.app.create",
  doing: "Backing up this App",
  authorize: ({ input, user }) =>
    permitted(user, (person) =>
      requireBackupTargetPermission(
        person,
        input.relayId,
        { id: input.appId, kind: "app" },
        "backup.create"
      )
    ),
  locks: ({ input }) => [
    shared(backupTargetKey(input.relayId, { id: input.appId, kind: "app" })),
    ...destinations(input.storageIds),
  ],
  run: ({ context: user, input }) =>
    promiseEffect(() => createAppBackupsHandler(user, input)),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

export const backUpPlatform = operation<PlatformBackupInput>()({
  name: "backup.platform.create",
  doing: "Backing up Kiln",
  authorize: ({ user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(
        isPlatformAdmin,
        () => new Error("Platform backups require administrator access")
      )
    ),
  locks: ({ input }) => [
    shared(backupTargetKey(input.relayId, { id: "", kind: "platform" })),
    ...destinations(
      input.storageIds ??
        (input.storageId === undefined ? undefined : [input.storageId])
    ),
  ],
  run: ({ context: user, input }) =>
    promiseEffect(() => createPlatformBackupHandler(user, input)),
  audit: ({ input }) => ({
    id: "platform",
    kind: "platform",
    relayId: input.relayId,
  }),
})

// A restore replaces its target's data, so it holds the target whole, and
// the backup it restores, so that isn't deleted under it. Its safety backup,
// taken first, is reserved within it.
const restoreOperation = <A>(
  name: string,
  doing: string,
  handler: (user: AuthenticatedUser, data: BackupRestoreInput) => Promise<A>
) =>
  operation<BackupRestoreInput>()({
    name,
    doing,
    authorize: ({ input, user }) =>
      signedIn(user).pipe(
        Effect.flatMap((person) =>
          Effect.gen(function* () {
            const backup = yield* getBackupCatalogRecordEffect(input.backupId)
            // The run says why one that's gone can't be restored.
            if (!backup) return { backup: null, storageIds: [], user: person }
            yield* promiseEffect(() => requireBackupAction(person, backup))
            const storageIds =
              input.safetyBackup && backup.targetKind !== "platform"
                ? yield* promiseEffect(() =>
                    resolveBackupStorageSelection({
                      relayId: backup.relayId,
                      targetId: backup.targetId,
                      targetKind: backup.targetKind as Exclude<
                        typeof backup.targetKind,
                        "platform"
                      >,
                    })
                  )
                : []
            return { backup, storageIds, user: person }
          })
        )
      ),
    locks: ({ context: { backup, storageIds } }) =>
      backup ? [...restoreLocks(backup), ...destinations(storageIds)] : [],
    run: ({ context, input }) =>
      promiseEffect(() => handler(context.user, input)),
    audit: ({ context: { backup } }) =>
      backup
        ? {
            id: backup.targetId,
            kind: backup.targetKind,
            relayId: backup.relayId,
          }
        : null,
  })

export const restoreInstance = restoreOperation(
  "backup.instance.restore",
  "Restoring this game server",
  restoreInstanceBackupHandler
)
export const restoreDatabase = restoreOperation(
  "backup.database.restore",
  "Restoring this database",
  restoreDatabaseBackupHandler
)
export const restoreResource = restoreOperation(
  "backup.resource.restore",
  "Restoring this App's folder or volume",
  restoreResourceBackupHandler
)

// Finishing or abandoning a restore whose swap didn't finish changes its
// target as the restore did.
export const resolveRestore = operation<{
  action: "abandon" | "finish"
  relayId: string
  taskId: string
}>()({
  name: "backup.restore.resolve",
  doing: "Finishing a restore",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        Effect.gen(function* () {
          const backup = yield* getBackupForTaskEffect(input.taskId)
          // The run says why one it doesn't know can't be resolved.
          if (backup) {
            yield* promiseEffect(() => requireBackupAction(person, backup))
          }
          return { backup, user: person }
        })
      )
    ),
  locks: ({ context: { backup } }) => (backup ? restoreLocks(backup) : []),
  run: ({ context, input }) =>
    promiseEffect(() => resolveUnfinishedRestoreHandler(context.user, input)),
  audit: ({ context: { backup }, input }) => ({
    id: backup?.targetId ?? input.taskId,
    kind: backup?.targetKind ?? "restore",
    relayId: input.relayId,
  }),
})

function restoreLocks(backup: BackupCatalogRecord): Array<LaneLock> {
  return [
    exclusive(
      backupTargetKey(backup.relayId, {
        id: backup.targetId,
        kind: backup.targetKind,
      })
    ),
    shared(backupKey(backup.id)),
  ]
}

async function requireBackupAction(
  user: AuthenticatedUser,
  backup: BackupCatalogRecord
): Promise<void> {
  const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
  if (!hasBackupPermission(user, grants, backup, "backup.restore")) {
    throw new Error("You do not have permission to restore this backup")
  }
}
