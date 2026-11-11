import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  databaseConnectionUrl,
  databaseEngineHasNamedDatabase,
  type ResourceLimits,
} from "@workspace/contracts"
import {
  ArrowRight,
  Cable,
  Check,
  Copy,
  Download,
  HardDriveDownload,
  KeyRound,
  LoaderCircle,
  ScrollText,
  Upload,
} from "lucide-react"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  DATABASE_DUMP_ACCEPT,
  ImportDatabaseDialog,
  RotateDatabasePasswordButton,
  useDatabaseExport,
} from "@/components/database/database-dialogs"
import {
  engineProductLabel,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import type { BackupTarget } from "@workspace/contracts"
import { EditableIcon } from "@/components/icon-editor-dialog"
import {
  InfoCopyValue,
  InfoFact,
  InfoSecretValue,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceContainerSection } from "@/components/instance-container-section"
import { InstanceFavoriteToggle } from "@/components/instance-favorite"
import {
  InstanceProfile,
  InstanceProfileBrick,
} from "@/components/instance-profile"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { RenameButton } from "@/components/rename-dialog"
import { useCopyFeedback } from "@/components/workspace-header"
import { formatBytes } from "@/lib/format-bytes"
import {
  backupUsageQueryOptions,
  managedDatabaseContainerQueryOptions,
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { formatDiskLimit } from "@/lib/resource-limits"
import {
  renameManagedDatabase,
  updateManagedDatabaseLimits,
} from "@/server/databases"

// The database's details on its Info page, one section per concern, each
// with the actions that change it.

const DATABASE_NAME_MAX_LENGTH = 120
const MASK = "••••••••••••"

// What the database is, in the profile every kind of instance has: the
// engine it runs and the image that is deployed from.
export function DatabaseProfile({
  canRename,
  database,
}: {
  canRename: boolean
  database: ManagedDatabase
}) {
  const editor = React.useMemo(
    () => ({
      fallback: <DatabaseKindIcon />,
      fit: "contain" as const,
      noun: "database",
      subject: {
        kind: "database" as const,
        relayId: database.relayId,
        id: database.id,
      },
      title: "Database icon",
    }),
    [database.id, database.relayId]
  )
  return (
    <InstanceProfile
      brick={
        <InstanceProfileBrick
          icon={
            <LiveServerBrickIcon
              brickId={database.brickId}
              className="size-4 shrink-0"
              implementation={database.engine}
            />
          }
        >
          {engineProductLabel(database)}
        </InstanceProfileBrick>
      }
      favorite={
        <InstanceFavoriteToggle
          id={database.id}
          kind="database"
          name={database.name}
          relayId={database.relayId}
          variant="outline"
        />
      }
      icon={<EditableIcon canEdit={canRename} editor={editor} />}
      id={database.id}
      idLabel="database ID"
      name={database.name}
      rename={canRename ? <DatabaseRenameButton database={database} /> : null}
    >
      <InfoFact label="Image">
        <InfoCopyValue label="image" value={database.image} />
      </InfoFact>
    </InstanceProfile>
  )
}

// Hearth keeps the name, so renaming doesn't need the Relay.
function DatabaseRenameButton({ database }: { database: ManagedDatabase }) {
  const queryClient = useQueryClient()
  const rename = React.useCallback(
    async (name: string) => {
      await renameManagedDatabase({
        data: { databaseId: database.id, name, relayId: database.relayId },
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.databases.all })
    },
    [database.id, database.relayId, queryClient]
  )
  return (
    <RenameButton
      compact
      id={database.id}
      maxLength={DATABASE_NAME_MAX_LENGTH}
      name={database.name}
      noun="database"
      rename={rename}
    />
  )
}

// Where and how game servers log in. Secrets stay in memory only while this
// page shows them, and stay masked until revealed.
export function DatabaseCredentialsSection({
  available,
  canRotate,
  database,
}: {
  available: boolean
  canRotate: boolean
  database: ManagedDatabase
}) {
  const queryClient = useQueryClient()
  const credential = useQuery(
    managedDatabaseCredentialQueryOptions(database.relayId, database.id)
  )
  React.useEffect(
    () => () => {
      queryClient.removeQueries({
        exact: true,
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
    },
    [database.id, database.relayId, queryClient]
  )
  const values = credential.data

  return (
    <InfoSection
      icon={<KeyRound />}
      title="Credentials"
      action={
        <>
          <CopyConnectionUrlButton
            url={
              values
                ? databaseConnectionUrl({
                    databaseName: database.databaseName,
                    engine: database.engine,
                    host: database.hostname,
                    password: encodeURIComponent(values.password),
                    port: database.internalPort,
                    username: values.username,
                  })
                : null
            }
          />
          {canRotate ? (
            <RotateDatabasePasswordButton
              database={database}
              disabledReason={
                available ? undefined : "Reconnect this database's Relay first"
              }
              size="sm"
            />
          ) : null}
        </>
      }
    >
      <InfoFact label="Hostname">
        <InfoCopyValue label="hostname" value={database.hostname} />
      </InfoFact>
      {/* Key-value stores have no named database to connect to. */}
      {hasNamedDatabase(database) ? (
        <InfoFact label="Database">
          <InfoCopyValue label="database" value={database.databaseName} />
        </InfoFact>
      ) : null}
      {credential.isError ? (
        <InfoFact label="Error">
          <span
            className="truncate font-mono text-xs text-destructive"
            title={credential.error.message}
          >
            {credential.error.message}
          </span>
        </InfoFact>
      ) : (
        <>
          <InfoFact label="Username">
            {values ? (
              <InfoCopyValue label="username" value={values.username} />
            ) : (
              <CredentialPending />
            )}
          </InfoFact>
          <InfoFact label="Password">
            {values ? (
              <InfoSecretValue
                label="password"
                masked={MASK}
                value={values.password}
              />
            ) : (
              <CredentialPending />
            )}
          </InfoFact>
        </>
      )}
    </InfoSection>
  )
}

// Copies the full URL, password included, without showing it.
function CopyConnectionUrlButton({ url }: { url: string | null }) {
  const { copied, copy } = useCopyFeedback(url ?? "")
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!url}
      className={
        copied
          ? "text-emerald-400 hover:text-emerald-400 light:text-emerald-700 light:hover:text-emerald-700"
          : undefined
      }
      onClick={() => void copy()}
    >
      Connection URL
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

function CredentialPending() {
  return (
    <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
  )
}

// Data in and out: drop a SQL dump to import it, export one, or restore a
// backup from the Backups page.
export function DatabaseDataSection({
  available,
  canExport,
  canImport,
  canRestore,
  canView,
  database,
}: {
  available: boolean
  canExport: boolean
  canImport: boolean
  canRestore: boolean
  canView: boolean
  database: ManagedDatabase
}) {
  const exportDump = useDatabaseExport(database)
  const unavailableReason = available
    ? undefined
    : "Reconnect this database's Relay first"

  return (
    <InfoSection
      icon={<HardDriveDownload />}
      title="Data"
      content
      action={
        <>
          {canExport ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!available || exportDump.isPending}
              title={unavailableReason}
              onClick={() => exportDump.mutate()}
            >
              {exportDump.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Download />
              )}
              Export SQL
            </Button>
          ) : null}
          {canView ? (
            <InfoSectionLink
              to="/db/$databaseId/viewer"
              params={{ databaseId: database.id }}
            >
              View Data
            </InfoSectionLink>
          ) : null}
          {canRestore ? (
            <RestoreBackupLink
              emptyMessage="No backups found for this database"
              relayId={database.relayId}
              search={{
                kind: "database",
                relay: database.relayId,
                server: database.id,
              }}
              target={{ id: database.id, kind: "database" }}
            />
          ) : null}
        </>
      }
    >
      {canImport ? (
        <DatabaseImportDropZone
          database={database}
          disabledReason={unavailableReason}
        />
      ) : null}
    </InfoSection>
  )
}

// Opens a database's backups on the Backups page, where they're restored.
// With none finished yet, it says so instead.
export function RestoreBackupLink({
  emptyMessage,
  relayId,
  search,
  target,
}: {
  emptyMessage: string
  relayId: string
  search: { kind: "database" | "relay"; relay: string; server: string }
  target: BackupTarget
}) {
  const { data } = useQuery(backupUsageQueryOptions(relayId, target))
  if (data && data.quantityAvailable > 0) {
    return (
      <InfoSectionLink to="/backups/runs" search={search}>
        Restore Backup
      </InfoSectionLink>
    )
  }
  const disabled = (
    <Button type="button" size="sm" variant="outline" disabled>
      Restore Backup
      <ArrowRight />
    </Button>
  )
  // Still counting: disabled, with nothing to explain yet.
  if (!data) return disabled
  return (
    <Tooltip>
      {/* A disabled button gets no hover, so its wrapper takes it. */}
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex outline-none">
          {disabled}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {emptyMessage}
      </TooltipContent>
    </Tooltip>
  )
}

function DatabaseImportDropZone({
  database,
  disabledReason,
}: {
  database: ManagedDatabase
  disabledReason: string | undefined
}) {
  const [file, setFile] = React.useState<File | null>(null)
  return (
    <>
      <SqlImportDropZone disabledReason={disabledReason} onFile={setFile} />
      {file ? (
        <ImportDatabaseDialog
          database={database}
          initialFile={file}
          open
          onOpenChange={(open) => {
            if (!open) setFile(null)
          }}
        />
      ) : null}
    </>
  )
}

// Dropping or choosing a dump hands it on, to an import that confirms it
// first.
export function SqlImportDropZone({
  disabledReason,
  label = "Upload a .sql or .dmp file to import",
  limit,
  onFile,
}: {
  disabledReason: string | undefined
  label?: string
  limit?: string
  onFile: (file: File) => void
}) {
  const [dragging, setDragging] = React.useState(false)
  const disabled = Boolean(disabledReason)

  return (
    <label
      title={disabledReason}
      className={cn(
        "flex flex-col items-center gap-1.5 border border-dashed px-4 py-6 text-center transition-colors focus-within:border-primary",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:border-primary/70 hover:bg-muted/30",
        dragging && "border-primary bg-primary/5"
      )}
      onDragOver={(event) => {
        if (disabled) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (disabled) return
        const dropped = event.dataTransfer.files[0]
        if (dropped) onFile(dropped)
      }}
    >
      <Upload className="size-5 text-muted-foreground" />
      <span className="text-[0.8125rem] font-medium">{label}</span>
      {limit ? (
        <span className="text-xs text-muted-foreground">{limit}</span>
      ) : null}
      <input
        accept={DATABASE_DUMP_ACCEPT}
        className="sr-only"
        disabled={disabled}
        type="file"
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0]
          if (chosen) onFile(chosen)
          event.currentTarget.value = ""
        }}
      />
    </label>
  )
}

// How game servers, Apps, and other databases reach the database: only from
// inside the Relay, once they're connected on its network.
export function DatabaseConnectionSettings({
  canViewNetwork,
  database,
}: {
  canViewNetwork: boolean
  database: ManagedDatabase
}) {
  const connected = database.members.length
  return (
    <InfoSection
      icon={<Cable />}
      title="Connection"
      action={
        canViewNetwork ? (
          <InfoSectionLink
            to="/db/$databaseId/network"
            params={{ databaseId: database.id }}
          >
            Network
          </InfoSectionLink>
        ) : null
      }
    >
      <InfoFact label="Internal address">
        <InfoCopyValue
          label="internal address"
          value={`${database.hostname}:${database.internalPort}`}
        />
      </InfoFact>
      <InfoFact label="Connections">
        <span className={connected === 0 ? "text-muted-foreground" : undefined}>
          {connected === 0 ? "None" : connected}
        </span>
      </InfoFact>
    </InfoSection>
  )
}

function hasNamedDatabase(database: Pick<ManagedDatabase, "engine">): boolean {
  return databaseEngineHasNamedDatabase(database.engine)
}

// A database's container: what it is, its usage against its limits, and
// those limits, which open from the header. Databases warn rather than
// stop at their disk limit, so a full disk never takes one offline. The
// Relay reports the container's name, data folder, and volume size on
// request, and only while it's reachable.
export function DatabaseContainerSection({
  available,
  canReadLogs,
  database,
  editable,
}: {
  available: boolean
  canReadLogs: boolean
  database: ManagedDatabase
  editable: boolean
}) {
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery({
    ...managedDatabaseContainerQueryOptions(database.relayId, database.id),
    enabled: available,
  })
  const pending = available && isPending
  const groups = React.useMemo(
    () => [{ key: "database", limits: database.limits }],
    [database.limits]
  )
  const target = React.useMemo(
    () => ({
      id: database.id,
      kind: "database" as const,
      relayId: database.relayId,
    }),
    [database.id, database.relayId]
  )
  const running = database.observedState === "running"
  const usage = React.useMemo(
    () => ({ ...target, running }),
    [running, target]
  )
  const container = React.useMemo(
    () => ({
      id: database.containerId,
      name: data?.containerName ?? null,
      pending,
    }),
    [data?.containerName, database.containerId, pending]
  )
  const save = React.useCallback(
    async (limits: Readonly<Record<string, ResourceLimits>>) => {
      const next = limits.database
      if (!next) return
      await updateManagedDatabaseLimits({
        data: {
          databaseId: database.id,
          limits: next,
          relayId: database.relayId,
        },
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.databases.all })
    },
    [database.id, database.relayId, queryClient]
  )
  return (
    <InstanceContainerSection
      container={container}
      dataDirectory={data?.dataDirectory ?? null}
      disk={
        data?.volumeBytes != null ? (
          <span className="tabular-nums">
            {formatBytes(data.volumeBytes)} used
            {database.limits.diskBytes === null
              ? ""
              : ` of ${formatBytes(database.limits.diskBytes)}`}
          </span>
        ) : pending ? (
          <LoaderCircle
            aria-label="Loading"
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : (
          <span className="tabular-nums">
            {formatDiskLimit(database.limits.diskBytes)}
          </span>
        )
      }
      limits={database.limits}
      limitsDialog={{
        disabledReason: available
          ? undefined
          : "Reconnect this database's Relay first",
        editable,
        groups,
        hint: "Changing memory or CPU applies at once. Removing one restarts the database. Over its disk limit, the database keeps running and everyone with access is warned.",
        onSave: save,
        target,
      }}
      links={
        canReadLogs ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                aria-label="Logs"
                to="/db/$databaseId/logs"
                params={{ databaseId: database.id }}
                className={cn(
                  buttonVariants({ size: "icon-sm", variant: "ghost" }),
                  "text-muted-foreground hover:text-foreground"
                )}
              >
                <ScrollText />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">Logs</TooltipContent>
          </Tooltip>
        ) : null
      }
      usage={usage}
    />
  )
}
