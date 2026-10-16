import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Cable,
  Database,
  Download,
  Eye,
  EyeOff,
  HardDriveDownload,
  KeyRound,
  LoaderCircle,
  RotateCw,
  Upload,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import {
  ImportDatabaseDialog,
  useDatabaseExport,
} from "@/components/database/database-dialogs"
import {
  engineBadgeClasses,
  engineLabel,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import {
  InfoCopyValue,
  InfoFact,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LocalDateTime } from "@/components/local-date-time"
import {
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { rotateManagedDatabasePassword } from "@/server/databases"

// The database's details on its Info page, one section per concern, each
// with the actions that change it.

export function DatabaseGeneralSettings({
  database,
}: {
  database: ManagedDatabase
}) {
  const version = database.image.split(":").at(1)
  return (
    <InfoSection
      icon={<Database />}
      title="Database"
      action={
        <InstanceFavoriteButton
          id={database.id}
          kind="database"
          relayId={database.relayId}
        />
      }
    >
      <InfoFact label="Name">
        <InfoCopyValue
          label="database name"
          mono={false}
          value={database.name}
        />
      </InfoFact>
      <InfoFact label="ID">
        <InfoCopyValue label="database ID" value={database.id} />
      </InfoFact>
      <InfoFact label="Engine">
        <Badge
          variant="outline"
          className={`type-meta font-mono uppercase ${engineBadgeClasses[database.engine]}`}
        >
          {engineLabel(database.engine)}
        </Badge>
        {version ? <span className="font-mono text-xs">{version}</span> : null}
      </InfoFact>
      <InfoFact label="Created">
        <LocalDateTime timestamp={database.createdAt} />
      </InfoFact>
    </InfoSection>
  )
}

// How game servers reach the database: only from inside the Relay, once
// they're connected on its network.
export function DatabaseConnectionSettings({
  canViewNetwork,
  database,
  routeId,
}: {
  canViewNetwork: boolean
  database: ManagedDatabase
  routeId: string
}) {
  const connected = database.connectedInstanceIds.length
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
      {/* Key-value stores have no named database to connect to. */}
      {hasNamedDatabase(database) ? (
        <InfoFact label="Database">
          <InfoCopyValue label="database" value={database.databaseName} />
        </InfoFact>
      ) : null}
      <InfoFact label="Game servers">
        <span className={connected === 0 ? "text-muted-foreground" : undefined}>
          {connected === 0 ? "None connected" : `${connected} connected`}
        </span>
      </InfoFact>
    </InfoSection>
  )
}

// The login game servers use. Secrets are fetched only once revealed, and
// stay in memory only while this page shows them.
export function DatabaseCredentialsSection({
  canRotate,
  database,
}: {
  canRotate: boolean
  database: ManagedDatabase
}) {
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = React.useState(false)
  const credential = useQuery({
    ...managedDatabaseCredentialQueryOptions(database.relayId, database.id),
    enabled: revealed,
  })
  React.useEffect(
    () => () => {
      queryClient.removeQueries({
        exact: true,
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
    },
    [database.id, database.relayId, queryClient]
  )
  const rotate = useMutation({
    mutationFn: () =>
      rotateManagedDatabasePassword({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
      showToast({ message: "Database password rotated", type: "success" })
    },
    onError: (error) =>
      showToast({
        message: `Password rotation failed: ${error.message}`,
        type: "error",
      }),
  })
  const values = revealed ? credential.data : undefined

  return (
    <InfoSection
      icon={<KeyRound />}
      title="Credentials"
      action={
        <>
          {/* Shown beside the password it changes. */}
          {canRotate && revealed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              Rotate password
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOff /> : <Eye />}
            {revealed ? "Hide" : "Reveal"}
          </Button>
        </>
      }
    >
      {revealed && credential.isError ? (
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
            <SecretValue
              label="username"
              pending={revealed}
              value={values?.username}
            />
          </InfoFact>
          <InfoFact label="Password">
            <SecretValue
              label="password"
              pending={revealed}
              value={values?.password}
            />
          </InfoFact>
          <InfoFact label="Connection URL">
            <SecretValue
              label="connection URL"
              pending={revealed}
              value={
                values ? databaseConnectionUrl(database, values) : undefined
              }
            />
          </InfoFact>
        </>
      )}
    </InfoSection>
  )
}

// Masked until revealed, then a spinner until the credential arrives.
function SecretValue({
  label,
  pending,
  value,
}: {
  label: string
  pending: boolean
  value: string | undefined
}) {
  if (value !== undefined) return <InfoCopyValue label={label} value={value} />
  if (pending) {
    return (
      <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
    )
  }
  return (
    <span
      aria-label="Hidden"
      className="font-mono text-xs tracking-widest text-muted-foreground"
    >
      ••••••••
    </span>
  )
}

// Moving data in and out as a SQL dump.
export function DatabaseDataSection({
  available,
  canExport,
  canImport,
  database,
}: {
  available: boolean
  canExport: boolean
  canImport: boolean
  database: ManagedDatabase
}) {
  const exportDump = useDatabaseExport(database)
  const [importOpen, setImportOpen] = React.useState(false)
  const unavailableReason = available
    ? undefined
    : "Reconnect this database's Relay first"

  return (
    <InfoSection
      icon={<HardDriveDownload />}
      title="Data"
      action={
        <>
          {canImport ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!available}
              title={unavailableReason}
              onClick={() => setImportOpen(true)}
            >
              <Upload />
              Import SQL
            </Button>
          ) : null}
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
        </>
      }
    >
      <InfoFact label="Format">SQL dump</InfoFact>
      <InfoFact label="Imports">
        <span className="truncate">
          Into{" "}
          <span className="font-mono text-xs">{database.databaseName}</span>,
          keeping existing data
        </span>
      </InfoFact>
      {importOpen ? (
        <ImportDatabaseDialog
          database={database}
          open
          onOpenChange={setImportOpen}
        />
      ) : null}
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
  credential: { password: string; username: string }
): string {
  const scheme =
    database.engine === "postgres"
      ? "postgresql"
      : hasNamedDatabase(database)
        ? "mysql"
        : "redis"
  const path =
    scheme === "redis" ? "" : `/${encodeURIComponent(database.databaseName)}`
  return `${scheme}://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@${database.hostname}:${database.internalPort}${path}`
}
