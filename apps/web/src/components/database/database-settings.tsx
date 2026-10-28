import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ResourceLimits } from "@workspace/contracts"
import {
  ArrowRight,
  Cable,
  Check,
  Copy,
  Download,
  HardDriveDownload,
  KeyRound,
  LoaderCircle,
  Upload,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
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
import type { HearthBackupTarget } from "@/lib/backup-targets"
import { EditableIcon } from "@/components/icon-editor-dialog"
import {
  InfoCopyValue,
  InfoFact,
  InfoProfile,
  InfoSecretValue,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { RenameButton } from "@/components/rename-dialog"
import { useCopyFeedback } from "@/components/workspace-header"
import {
  backupUsageQueryOptions,
  managedDatabaseCapacityQueryOptions,
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { ResourceLimitsSection } from "@/components/resource-limits-section"
import {
  renameManagedDatabase,
  updateManagedDatabaseLimits,
} from "@/server/databases"

// The database's details on its Info page, one section per concern, each
// with the actions that change it.

const DATABASE_NAME_MAX_LENGTH = 120
const MASK = "••••••••••••"

export function DatabaseGeneralSettings({
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
    <InfoProfile
      icon={<EditableIcon canEdit={canRename} editor={editor} />}
      id={database.id}
      idLabel="database ID"
      name={database.name}
      actions={
        <>
          {canRename ? <DatabaseRenameButton database={database} /> : null}
          <InstanceFavoriteButton
            id={database.id}
            kind="database"
            relayId={database.relayId}
          />
        </>
      }
    >
      <InfoFact label="Engine">
        <InfoCopyValue
          label="engine"
          mono={false}
          value={engineProductLabel(database)}
        />
      </InfoFact>
    </InfoProfile>
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
                ? databaseConnectionUrl(
                    database,
                    values.username,
                    encodeURIComponent(values.password)
                  )
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
  routeId,
}: {
  available: boolean
  canExport: boolean
  canImport: boolean
  canRestore: boolean
  canView: boolean
  database: ManagedDatabase
  routeId: string
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
              params={{ databaseId: routeId }}
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
  target: HearthBackupTarget
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
  routeId,
}: {
  canViewNetwork: boolean
  database: ManagedDatabase
  routeId: string
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
            params={{ databaseId: routeId }}
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
  return database.engine !== "redis" && database.engine !== "valkey"
}

function databaseConnectionUrl(
  database: Pick<
    ManagedDatabase,
    "databaseName" | "engine" | "hostname" | "internalPort"
  >,
  username: string,
  // Already encoded, or a mask shown in its place.
  password: string
): string {
  const scheme =
    database.engine === "postgres"
      ? "postgresql"
      : hasNamedDatabase(database)
        ? "mysql"
        : "redis"
  const path =
    scheme === "redis" ? "" : `/${encodeURIComponent(database.databaseName)}`
  return `${scheme}://${encodeURIComponent(username)}:${password}@${database.hostname}:${database.internalPort}${path}`
}

// Databases warn rather than stop at their disk limit, so a full disk never
// takes one offline.
export function DatabaseLimitsSection({
  available,
  database,
  editable,
}: {
  available: boolean
  database: ManagedDatabase
  editable: boolean
}) {
  const queryClient = useQueryClient()
  const { data: capacity = null } = useQuery({
    ...managedDatabaseCapacityQueryOptions(database.relayId, database.id),
    enabled: editable && available,
  })
  const groups = React.useMemo(
    () => [{ key: "database", limits: database.limits }],
    [database.limits]
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.databases.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.databases.capacity(database.relayId, database.id),
        }),
      ])
    },
    [database.id, database.relayId, queryClient]
  )
  return (
    <ResourceLimitsSection
      capacity={capacity}
      disabledReason={
        available ? undefined : "Reconnect this database's Relay first"
      }
      editable={editable}
      groups={groups}
      hint="Changing memory or CPU applies at once. Removing one restarts the database. Over its disk limit, the database keeps running and everyone with access is warned."
      onSave={save}
    />
  )
}
