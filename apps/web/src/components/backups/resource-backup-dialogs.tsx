import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"

import {
  BackupConfigurationDialog,
  type BackupConfiguration,
} from "@/components/backup-configuration-dialog"
import type { Backup } from "@/components/backups/state"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import {
  appDirectoryQueryOptions,
  backupStorageQueryOptions,
  queryKeys,
  relayVolumesQueryOptions,
} from "@/lib/query-options"
import {
  createAppBackups,
  createResourceBackup,
  resolveUnfinishedRestore,
  restoreResourceBackup,
} from "@/server/backups"

/** What a backup of an App's folder or a volume names. */
export type ResourceTarget = { id: string; kind: "app" | "volume" }

// The destinations a configuration chose, or none for the target's own.
function storageIds(configuration: BackupConfiguration) {
  return configuration.destinationKeys.includes("default")
    ? {}
    : {
        storageIds: configuration.destinationKeys.map((destination) =>
          destination === "local" ? null : destination
        ),
      }
}

/**
 * Backs up an App, its folder and each volume it owns together, or one App
 * folder or volume, live or with what uses it stopped.
 */
export function ResourceBackupDialog({
  description,
  onOpenChange,
  open,
  relayId,
  stoppedUnavailable,
  target,
  title,
}: {
  description: React.ReactNode
  onOpenChange: (open: boolean) => void
  open: boolean
  relayId: string
  stoppedUnavailable: string | null
  /** A whole App, or one of its folder or a volume. */
  target: { appId: string; kind: "whole-app" } | ResourceTarget
  title: string
}) {
  const queryClient = useQueryClient()
  const storage = useQuery(backupStorageQueryOptions())
  const create = useMutation({
    mutationFn: (
      configuration: BackupConfiguration
    ): Promise<{ relayAccepted: boolean }> =>
      target.kind === "whole-app"
        ? createAppBackups({
            data: {
              appId: target.appId,
              consistency: configuration.consistency,
              name: configuration.name,
              relayId,
              ...storageIds(configuration),
            },
          })
        : createResourceBackup({
            data: {
              consistency: configuration.consistency,
              name: configuration.name,
              relayId,
              target,
              ...storageIds(configuration),
            },
          }),
    onSuccess: async (result, configuration) => {
      await Promise.all([
        resetActiveBackupRunsToFirstPage(queryClient),
        queryClient.invalidateQueries({ queryKey: ["backups", "app"] }),
      ])
      showToast({
        message: result.relayAccepted
          ? `${configuration.name} queued`
          : `${configuration.name} saved and will resume when the Relay reconnects`,
        type: result.relayAccepted ? "success" : "warning",
      })
      onOpenChange(false)
    },
  })
  return (
    <BackupConfigurationDialog
      consistencyChoice={{
        stoppedDescription:
          target.kind === "whole-app"
            ? "Stops it once for its folder and every volume"
            : undefined,
        stoppedUnavailable,
      }}
      description={description}
      error={create.error?.message}
      onOpenChange={onOpenChange}
      onSubmit={(configuration) => create.mutate(configuration)}
      open={open}
      pending={create.isPending}
      showTarget={false}
      storage={storage.data ?? []}
      submitLabel={create.isPending ? "Starting backup…" : "Back up"}
      targets={[]}
      title={title}
    />
  )
}

/**
 * Restores an App's folder or a volume, saying first what must be stopped:
 * the App, or every container that mounts the volume, which the Relay
 * checks too.
 */
export function ResourceRestoreDialog({
  backup,
  onOpenChange,
  open,
  targetName,
}: {
  backup: Backup
  onOpenChange: (open: boolean) => void
  open: boolean
  targetName: string
}) {
  const queryClient = useQueryClient()
  const [safetyBackup, setSafetyBackup] = React.useState(true)
  const volume = backup.targetKind === "volume"
  const volumes = useQuery({
    ...relayVolumesQueryOptions(backup.relayId),
    enabled: open,
  })
  const apps = useQuery({ ...appDirectoryQueryOptions(), enabled: open })
  const appName = React.useCallback(
    (appId: string) =>
      apps.data?.find((app) => app.id === appId)?.name ?? appId.slice(0, 8),
    [apps.data]
  )
  const running = React.useMemo(() => {
    if (!volumes.data) return null
    if (volume) {
      const found = volumes.data.volumes.find(
        (candidate) => candidate.id === backup.targetId
      )
      return (found?.mounts ?? [])
        .filter((mount) => mount.running)
        .map((mount) =>
          mount.kind === "app" && mount.resourceId
            ? `${appName(mount.resourceId)} (${mount.container})`
            : mount.container
        )
    }
    return null
  }, [appName, backup.targetId, volume, volumes.data])
  const users = React.useMemo(() => {
    if (!volume || !volumes.data) return []
    const found = volumes.data.volumes.find(
      (candidate) => candidate.id === backup.targetId
    )
    return [
      ...new Set([
        ...(found?.owner ? [found.owner.appId] : []),
        ...(found?.users.map((user) => user.appId) ?? []),
      ]),
    ].map(appName)
  }, [appName, backup.targetId, volume, volumes.data])
  const restore = useMutation({
    mutationFn: () =>
      restoreResourceBackup({ data: { backupId: backup.id, safetyBackup } }),
    onSuccess: async (result) => {
      await Promise.all([
        resetActiveBackupRunsToFirstPage(queryClient),
        queryClient.invalidateQueries({ queryKey: ["backups", "app"] }),
      ])
      showToast({
        message: result.relayAccepted
          ? `Restore of ${targetName} queued`
          : "Restore saved and will resume when the Relay reconnects",
        type: result.relayAccepted ? "success" : "warning",
      })
      onOpenChange(false)
    },
  })
  const blocked = running !== null && running.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {targetName}</DialogTitle>
          <DialogDescription>
            {volume
              ? `This replaces everything in the volume with “${backup.name}”. Every container that mounts it must be stopped, and the Apps that use it can’t start until the restore is done.`
              : `This replaces the App’s folder with “${backup.name}”. Stop the App first; it can’t start until the restore is done.`}
          </DialogDescription>
        </DialogHeader>
        {volume && users.length > 0 ? (
          <p className="type-meta text-muted-foreground">
            Apps that use it: {users.join(", ")}. Restoring it takes permission
            to change each one’s files.
          </p>
        ) : null}
        {blocked ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Running now: {running.join(", ")}. Stop them first.</span>
          </p>
        ) : null}
        <label className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-background/35 p-3">
          <span>
            <span className="block text-xs font-semibold">Safety backup</span>
            <span className="type-meta mt-1 block text-muted-foreground">
              Back up what it holds now, live, before restoring.
            </span>
          </span>
          <Switch
            aria-label="Take a safety backup before restore"
            checked={safetyBackup}
            onCheckedChange={setSafetyBackup}
          />
        </label>
        {restore.error ? (
          <p className="text-xs text-destructive">{restore.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={restore.isPending || blocked}
            type="button"
            onClick={() => restore.mutate()}
          >
            {restore.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCcw />
            )}
            Restore backup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A restore whose swap didn't finish: its target holds part old files and
 * part restored ones, and nothing can change it, or start an App that uses
 * it, until someone finishes or abandons the restore.
 */
export const UnfinishedRestoreNotice = React.memo(
  function UnfinishedRestoreNotice({
    backupName,
    canResolve,
    relayId,
    targetName,
    taskId,
  }: {
    backupName: string | null
    canResolve: boolean
    relayId: string
    targetName: string
    taskId: string
  }) {
    const queryClient = useQueryClient()
    const [confirmingAbandon, setConfirmingAbandon] = React.useState(false)
    const resolve = useMutation({
      mutationFn: (action: "abandon" | "finish") =>
        resolveUnfinishedRestore({ data: { action, relayId, taskId } }),
      onSuccess: async (_, action) => {
        setConfirmingAbandon(false)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.backups.unfinished,
          }),
          queryClient.invalidateQueries({ queryKey: ["backups", "app"] }),
          resetActiveBackupRunsToFirstPage(queryClient),
        ])
        showToast({
          message:
            action === "finish"
              ? `Restore of ${targetName} finished`
              : `Restore of ${targetName} abandoned`,
          type: "success",
        })
      },
    })
    const pending = resolve.isPending
    return (
      <div
        className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
        role="status"
      >
        <p className="flex items-start gap-2 font-semibold">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          A restore of {targetName} didn’t finish
        </p>
        <p className="text-muted-foreground">
          {backupName ? `Restoring “${backupName}” stopped` : "It stopped"}{" "}
          partway, so it holds some old files and some restored ones. Nothing
          can change it, or start an App that uses it, until the restore
          finishes. Finishing stops the Apps running on it and moves the rest
          in; abandoning keeps it as it is now.
        </p>
        {resolve.error ? (
          <p className="text-destructive">{resolve.error.message}</p>
        ) : null}
        {canResolve ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={pending}
              size="sm"
              type="button"
              onClick={() => resolve.mutate("finish")}
            >
              {pending && resolve.variables === "finish" ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Finish restore
            </Button>
            {confirmingAbandon ? (
              <>
                <Button
                  disabled={pending}
                  size="sm"
                  type="button"
                  variant="destructive"
                  onClick={() => resolve.mutate("abandon")}
                >
                  {pending && resolve.variables === "abandon" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Abandon and keep it as it is
                </Button>
                <Button
                  disabled={pending}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmingAbandon(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                disabled={pending}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setConfirmingAbandon(true)}
              >
                Abandon
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">
            Someone who can restore it can finish or abandon it.
          </p>
        )}
      </div>
    )
  }
)
