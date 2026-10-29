import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Archive,
  Folder,
  HardDrive,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  ShieldOff,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { appRelayAvailable } from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  ResourceBackupDialog,
  ResourceRestoreDialog,
  UnfinishedRestoreNotice,
  type ResourceTarget,
} from "@/components/backups/resource-backup-dialogs"
import type { Backup } from "@/components/backups/state"
import {
  BackupCreatedTime,
  BackupTaskFeedback,
} from "@/components/backups/table-row"
import { InfoCard, InfoCardHeader } from "@/components/info-card"
import { appBackupsQueryOptions } from "@/lib/query-options"
import type { getAppBackups } from "@/server/backups"

type AppBackupsDialog =
  | { kind: "closed" }
  | { kind: "back-up"; target: ResourceTarget | null; title: string }
  | { backup: Backup; kind: "restore"; name: string }

const noBackups: ReadonlyArray<never> = []

/**
 * An App's Backups tab. Backing up the App backs up its folder and each
 * volume its Compose project owns, each a backup of its own, started
 * together; this shows whether all of them succeeded, and what it mounts
 * that no backup of it covers.
 */
export function AppBackupsPage() {
  const { app } = useAppWorkspace()
  const backups = useQuery(appBackupsQueryOptions(app.relayId, app.id))
  const [dialog, setDialog] = React.useState<AppBackupsDialog>({
    kind: "closed",
  })
  const close = React.useCallback((open: boolean) => {
    if (!open) setDialog({ kind: "closed" })
  }, [])
  const relayAvailable = appRelayAvailable(app)
  // App backups follow its file permissions: reading them makes one,
  // writing them restores one; stopping it is managing it.
  const canBackUp = relayAvailable && app.permissions.includes("app.files.read")
  const canRestore =
    relayAvailable && app.permissions.includes("app.files.write")
  const stoppedUnavailable = app.permissions.includes("app.manage")
    ? null
    : "Stopping it takes permission to manage the App"
  const data = backups.data
  const targets = data?.targets ?? noBackups
  const batch = data?.batch ?? noBackups

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto grid max-w-5xl gap-4 px-5 py-6 sm:px-8 sm:py-8">
        <InfoCard>
          <InfoCardHeader
            icon={<Archive />}
            title="Backups"
            action={
              <div className="flex items-center gap-2">
                <Button asChild size="sm" variant="ghost">
                  <Link
                    to="/backups/runs"
                    search={{ kind: "app", relay: app.relayId, server: app.id }}
                  >
                    <ListChecks /> All backups
                  </Link>
                </Button>
                <Button
                  disabled={!canBackUp || !data}
                  size="sm"
                  type="button"
                  onClick={() =>
                    setDialog({
                      kind: "back-up",
                      target: null,
                      title: `Back up ${app.name}`,
                    })
                  }
                >
                  <Archive /> Back up App
                </Button>
              </div>
            }
          />
          <p className="border-b px-4 py-3 text-sm text-muted-foreground">
            Backing up {app.name} backs up its folder and each volume its
            Compose file declares, each as a backup of its own, started
            together. Kiln volumes it uses are backed up on their own.
          </p>
          {backups.isPending ? (
            <div className="grid h-32 place-items-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : backups.isError ? (
            <p className="px-4 py-3 text-xs text-destructive">
              {backups.error.message}
            </p>
          ) : (
            <>
              {!data?.available ? (
                <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                  The Relay can’t be reached, so its volumes aren’t listed.
                </p>
              ) : null}
              {batch.length > 0 ? <BatchSummary batch={batch} /> : null}
              <ul className="divide-y">
                {targets.map((target) => (
                  <BackupTargetRow
                    key={`${target.kind}:${target.id}`}
                    canBackUp={canBackUp}
                    canRestore={canRestore}
                    relayId={app.relayId}
                    target={target}
                    onBackUp={(name) =>
                      setDialog({
                        kind: "back-up",
                        target: { id: target.id, kind: target.kind },
                        title: `Back up ${name}`,
                      })
                    }
                    onRestore={(backup, name) =>
                      setDialog({ backup, kind: "restore", name })
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </InfoCard>

        {data ? (
          <NotCovered uncovered={data.uncovered} used={data.used} />
        ) : null}
      </div>
      {dialog.kind === "back-up" ? (
        <ResourceBackupDialog
          description={
            dialog.target === null
              ? "Its folder and each volume it owns are backed up as backups of their own, started together."
              : "A full archive, read through Docker with each file’s owner and mode."
          }
          open
          relayId={app.relayId}
          stoppedUnavailable={stoppedUnavailable}
          target={
            dialog.target ?? { appId: app.id, kind: "whole-app" as const }
          }
          title={dialog.title}
          onOpenChange={close}
        />
      ) : null}
      {dialog.kind === "restore" ? (
        <ResourceRestoreDialog
          backup={dialog.backup}
          open
          targetName={dialog.name}
          onOpenChange={close}
        />
      ) : null}
    </section>
  )
}

type AppBackupTarget = Awaited<
  ReturnType<typeof getAppBackups>
>["targets"][number]

// Whether every backup the App's latest backup started succeeded.
const BatchSummary = React.memo(function BatchSummary({
  batch,
}: {
  batch: ReadonlyArray<Backup>
}) {
  const active = batch.filter(
    (backup) =>
      backup.taskStatus === "queued" || backup.taskStatus === "running"
  ).length
  const failed = batch.filter(
    (backup) => backup.status === "failed" || backup.taskStatus === "failed"
  ).length
  const newest = batch.reduce((latest, backup) =>
    backup.createdAt > latest.createdAt ? backup : latest
  )
  const summary =
    active > 0
      ? `${batch.length - active} of ${batch.length} done, ${active} still running`
      : failed > 0
        ? `${failed} of ${batch.length} failed`
        : `All ${batch.length} succeeded`
  return (
    <p
      className={`flex flex-wrap items-center gap-x-2 border-b px-4 py-2.5 text-xs ${
        failed > 0 && active === 0
          ? "text-destructive"
          : "text-muted-foreground"
      }`}
    >
      <span className="font-semibold">Last App backup, “{newest.name}”:</span>
      <span>{summary}</span>
      <BackupCreatedTime createdAt={newest.createdAt} />
    </p>
  )
})

const BackupTargetRow = React.memo(function BackupTargetRow({
  canBackUp,
  canRestore,
  onBackUp,
  onRestore,
  relayId,
  target,
}: {
  canBackUp: boolean
  canRestore: boolean
  onBackUp: (name: string) => void
  onRestore: (backup: Backup, name: string) => void
  relayId: string
  target: AppBackupTarget
}) {
  const name =
    target.kind === "app" ? "Folder" : `Volume ${target.name ?? target.id}`
  const latest = target.latest
  const restorable =
    latest?.status === "available" &&
    latest.taskStatus !== "queued" &&
    latest.taskStatus !== "running"
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border text-muted-foreground [&_svg]:size-4">
          {target.kind === "app" ? <Folder /> : <HardDrive />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="type-meta flex flex-wrap items-center gap-x-2 text-muted-foreground">
            {latest ? (
              <>
                <span>“{latest.name}”</span>
                <BackupCreatedTime createdAt={latest.createdAt} />
                {latest.consistency ? (
                  <span>
                    {latest.consistency === "stopped"
                      ? "Taken stopped"
                      : "Taken live"}
                  </span>
                ) : null}
                {latest.status === "failed" ? (
                  <span className="text-destructive">Failed</span>
                ) : null}
              </>
            ) : (
              <span>Never backed up</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            disabled={!canBackUp || target.unfinished !== null}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onBackUp(name)}
          >
            <Archive /> Back up
          </Button>
          <Button
            aria-label={`Restore ${name} from its latest backup`}
            disabled={!canRestore || !restorable || target.unfinished !== null}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => latest && onRestore(latest, name)}
          >
            <RotateCcw /> Restore
          </Button>
        </div>
      </div>
      {latest ? <BackupTaskFeedback backup={latest} destinations={[]} /> : null}
      {target.unfinished ? (
        <UnfinishedRestoreNotice
          backupName={null}
          canResolve={canRestore}
          relayId={relayId}
          targetName={
            target.kind === "app"
              ? "the App’s folder"
              : `volume ${target.name ?? target.id}`
          }
          taskId={target.unfinished.taskId}
        />
      ) : null}
    </li>
  )
})

// What the App mounts that its backups don't cover.
const NotCovered = React.memo(function NotCovered({
  uncovered,
  used,
}: {
  uncovered: ReadonlyArray<{
    container: string
    destination: string
    kind: "anonymous" | "bind" | "volume"
    service: string
    source: string
  }>
  used: ReadonlyArray<{ id: string; name: string }>
}) {
  if (uncovered.length === 0 && used.length === 0) return null
  return (
    <InfoCard>
      <InfoCardHeader icon={<ShieldOff />} title="Not in its backups" />
      <p className="border-b px-4 py-3 text-sm text-muted-foreground">
        Backing up the App doesn’t cover these, so don’t count on its backups to
        restore them.
      </p>
      <ul className="divide-y text-xs">
        {used.map((volume) => (
          <li key={volume.id} className="flex flex-wrap gap-x-2 px-4 py-2.5">
            <span className="font-medium">Kiln volume {volume.name}</span>
            <span className="text-muted-foreground">
              Shared, so it’s backed up on its own from its Relay’s volumes
            </span>
          </li>
        ))}
        {uncovered.map((mount) => (
          <li
            key={`${mount.container}:${mount.destination}`}
            className="flex flex-wrap gap-x-2 px-4 py-2.5"
          >
            <span className="font-medium">
              {mount.service} · {mount.destination}
            </span>
            <span className="text-muted-foreground">
              {mount.kind === "bind"
                ? `A path on the node, ${mount.source}`
                : mount.kind === "anonymous"
                  ? "A volume Docker named itself, as an image declares"
                  : `A volume Kiln doesn’t manage, ${mount.source}`}
            </span>
          </li>
        ))}
      </ul>
    </InfoCard>
  )
})
