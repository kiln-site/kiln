import { Effect } from "effect"

import {
  getBackupCatalogRecordEffect,
  getBackupForTaskEffect,
  getBackupPolicyEffect,
} from "@/effect/backups"
import { kilnInstallationId } from "@/effect/installation"
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
import type { BackupTarget } from "@workspace/contracts"
import type { BackupAction } from "@/lib/backup-target-permissions"
import { kilnInstallationId } from "@/effect/installation"
import { exclusive, partKey, shared, type LaneLock } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  createAppBackupsHandler,
  resolveUnfinishedRestoreHandler,
} from "@/server/app-backups.server"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import {
  cancelBackupHandler,
  copyBackupToDestinationHandler,
  createDatabaseBackupHandler,
  createInstanceBackupHandler,
  createPlatformBackupHandler,
  createResourceBackupHandler,
  deleteBackupHandler,
  getBackupDownloadUrlHandler,
  renameBackupHandler,
  syncBackupRunsHandler,
  updateBackupExcludesHandler,
  updateBackupLimitsHandler,
  restoreDatabaseBackupHandler,
  restoreInstanceBackupHandler,
  restoreResourceBackupHandler,
} from "@/server/backups.server"
import type {
  BackupDownloadInput,
  BackupExcludesInput,
  BackupIdInput,
  BackupLimitsInput,
  BackupRemovalInput,
  BackupRestoreInput,
  CopyBackupInput,
  DatabaseBackupInput,
  RenameBackupInput,
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

// An App's folder and the volumes it owns, together, to the destinations
// chosen for them or the App's preferred one.
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
    ).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => ({
          storageIds: await resolveBackupStorageSelection({
            relayId: input.relayId,
            storageIds: input.storageIds,
            targetId: input.appId,
            targetKind: "app",
          }),
          user: person,
        }))
      )
    ),
  locks: ({ context, input }) => [
    shared(backupTargetKey(input.relayId, { id: input.appId, kind: "app" })),
    ...destinations(context.storageIds),
  ],
  run: ({ context, input }) =>
    promiseEffect(() =>
      createAppBackupsHandler(context.user, {
        ...input,
        storageIds: context.storageIds,
      })
    ),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

export const backUpPlatform = operation<PlatformBackupInput>()({
  name: "backup.platform.create",
  doing: "Backing up Kiln",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(
        isPlatformAdmin,
        () => new Error("Platform backups require administrator access")
      ),
      Effect.flatMap((person) =>
        Effect.gen(function* () {
          const storageIds =
            input.storageIds ??
            (input.storageId === undefined
              ? [
                  (yield* getBackupPolicyEffect(
                    input.relayId,
                    "platform",
                    kilnInstallationId()
                  )).storageId,
                ]
              : [input.storageId])
          return { storageIds, user: person }
        })
      )
    ),
  locks: ({ context, input }) => [
    shared(backupTargetKey(input.relayId, { id: "", kind: "platform" })),
    ...destinations(context.storageIds),
  ],
  run: ({ context, input }) =>
    promiseEffect(() =>
      createPlatformBackupHandler(context.user, {
        ...input,
        storageId: undefined,
        storageIds: context.storageIds,
      })
    ),
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
  handler: (
    user: AuthenticatedUser,
    data: BackupRestoreInput,
    settledSafetyStorageIds?: ReadonlyArray<string | null>
  ) => Promise<A>
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
    // Its safety backup goes to the destinations it holds.
    run: ({ context, input }) =>
      promiseEffect(() =>
        handler(
          context.user,
          input,
          input.safetyBackup ? context.storageIds : undefined
        )
      ),
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

// A change to one backup: it holds that backup, exclusively unless it only
// reads from it, as copying and downloading do. Each checks the person may
// do it before any lane is taken; the run says why one that's gone can't.
const backupOperation = <
  Input extends { readonly backupId: string },
  A,
>(definition: {
  readonly name: string
  readonly doing: string | ((input: Input) => string)
  readonly action: (input: Input) => BackupAction
  readonly denied: (input: Input) => string
  readonly reads?: boolean
  readonly alsoLocks?: (input: Input) => Array<LaneLock>
  readonly handler: (user: AuthenticatedUser, input: Input) => Promise<A>
}) =>
  operation<Input>()({
    name: definition.name,
    doing: definition.doing,
    authorize: ({ input, user }) =>
      signedIn(user).pipe(
        Effect.flatMap((person) =>
          Effect.gen(function* () {
            const backup = yield* getBackupCatalogRecordEffect(input.backupId)
            if (backup) {
              yield* promiseEffect(async () => {
                const grants = isPlatformAdmin(person)
                  ? []
                  : await listUserGrants(person.id)
                if (
                  !hasBackupPermission(
                    person,
                    grants,
                    backup,
                    definition.action(input)
                  )
                ) {
                  throw new Error(definition.denied(input))
                }
              })
            }
            return { relayId: backup?.relayId ?? null, user: person }
          })
        )
      ),
    locks: ({ input }) => [
      definition.reads
        ? shared(backupKey(input.backupId))
        : exclusive(backupKey(input.backupId)),
      ...(definition.alsoLocks?.(input) ?? []),
    ],
    run: ({ context, input }) =>
      promiseEffect(() => definition.handler(context.user, input)),
    audit: ({ context, input }) => ({
      id: input.backupId,
      kind: "backup",
      relayId: context.relayId,
    }),
  })

export const cancelBackup = backupOperation({
  name: "backup.cancel",
  doing: "Cancelling this backup",
  action: () => "backup.create",
  denied: () => "You do not have permission to cancel this backup",
  handler: (user, input: BackupIdInput) => cancelBackupHandler(user, input),
})

export const removeBackup = backupOperation({
  name: "backup.delete",
  doing: (input: BackupRemovalInput) =>
    input.mode === "forget" ? "Removing this backup" : "Deleting this backup",
  action: (input) =>
    input.mode === "forget" ? "backup.read" : "backup.delete",
  denied: (input) => `You do not have permission to ${input.mode} this backup`,
  handler: deleteBackupHandler,
})

export const renameBackup = backupOperation({
  name: "backup.rename",
  doing: "Renaming this backup",
  action: () => "backup.create",
  denied: () => "You do not have permission to rename this backup",
  handler: (user, input: RenameBackupInput) => renameBackupHandler(user, input),
})

export const copyBackup = backupOperation({
  name: "backup.copy",
  doing: "Copying this backup",
  action: () => "backup.download",
  denied: () => "You do not have permission to copy this backup",
  reads: true,
  alsoLocks: (input: CopyBackupInput) => destinations([input.storageId]),
  handler: copyBackupToDestinationHandler,
})

// Signing a link, or preparing a snapshot's export to sign one for. Asking
// how an export is coming along is a read (getBackupExportState).
export const downloadBackup = backupOperation({
  name: "backup.download",
  doing: "Preparing a download of this backup",
  action: () => "backup.download",
  denied: () => "You do not have permission to download this backup",
  reads: true,
  handler: (user, input: BackupDownloadInput) =>
    getBackupDownloadUrlHandler(user, input),
})

// What a target's backups keep and leave out, and where they go.
export const backupPolicyLock = (
  relayId: string,
  target: { id: string; kind: BackupTarget["kind"] }
) => exclusive(partKey(backupTargetKey(relayId, target), "backup-policy"))

// Who may change a target's backup settings: an administrator the
// platform's, and whoever may back up any other.
export const backupSettingsPerson = (
  user: AuthenticatedUser | null,
  input: { relayId: string; target: BackupTarget }
) =>
  signedIn(user).pipe(
    Effect.tap((person) =>
      input.target.kind === "platform"
        ? isPlatformAdmin(person)
          ? Effect.void
          : Effect.fail(
              new Error("Platform backup settings require administrator access")
            )
        : promiseEffect(() =>
            requireBackupTargetPermission(
              person,
              input.relayId,
              input.target,
              "backup.create"
            )
          )
    )
  )

const policyAudit = (input: { relayId: string; target: BackupTarget }) => ({
  id: input.target.kind === "platform" ? kilnInstallationId() : input.target.id,
  kind: input.target.kind,
  relayId: input.relayId,
})

export const changeBackupLimits = operation<BackupLimitsInput>()({
  name: "backup.policy.limits",
  doing: "Changing these backup settings",
  authorize: ({ input, user }) => backupSettingsPerson(user, input),
  locks: ({ input }) => [backupPolicyLock(input.relayId, input.target)],
  run: ({ context: user, input }) =>
    promiseEffect(() => updateBackupLimitsHandler(user, input)),
  audit: ({ input }) => policyAudit(input),
})

export const changeBackupExcludes = operation<BackupExcludesInput>()({
  name: "backup.policy.excludes",
  doing: "Changing these backup settings",
  authorize: ({ input, user }) => backupSettingsPerson(user, input),
  locks: ({ input }) => [backupPolicyLock(input.relayId, input.target)],
  run: ({ context: user, input }) =>
    promiseEffect(() => updateBackupExcludesHandler(user, input)),
  audit: ({ input }) => policyAudit(input),
})

// Catalogs what the Relays report and sends them tasks they haven't taken.
// It takes no lanes: each task it sends was already admitted when it was
// reserved, and the catalog follows what the Relays did.
export const syncBackups = operation<void>()({
  name: "backup.sync",
  doing: "Syncing backups",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: user }) => promiseEffect(() => syncBackupRunsHandler(user)),
})
