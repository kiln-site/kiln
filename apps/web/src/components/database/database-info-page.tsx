import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  ArrowRight,
  Box,
  CalendarClock,
  Database,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  Globe2,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Network,
  RotateCw,
  Tags,
  Trash2,
  Upload,
  User,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DeleteDatabaseDialog,
  ImportDatabaseDialog,
  useDatabaseExport,
} from "@/components/database/database-dialogs"
import {
  databaseStatusPresentation,
  engineBadgeClasses,
  engineLabel,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import {
  CopyMetaRow,
  DangerZone,
  InfoCard,
  InfoCardHeader,
  MetaRow,
  ResourceUsersCard,
} from "@/components/info-card"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import {
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { rotateManagedDatabasePassword } from "@/server/databases"

const createdAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export function DatabaseInfoPage() {
  const { database, routeId } = useDatabaseWorkspace()
  const can = (permission: ManagedDatabase["permissions"][number]) =>
    database.permissions.includes(permission)
  const available = database.inventoryStatus === "available"

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <InfoCard>
              <InfoCardHeader
                icon={<Fingerprint />}
                title="Identity"
                action={
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`type-meta font-mono uppercase ${engineBadgeClasses[database.engine]}`}
                    >
                      {engineLabel(database.engine)}
                    </Badge>
                    <InstanceFavoriteButton
                      id={database.id}
                      kind="database"
                      relayId={database.relayId}
                    />
                  </div>
                }
              />
              <MetaRow icon={Database} label="Name" value={database.name} />
              <MetaRow
                icon={Fingerprint}
                label="Database full ID"
                value={database.id}
                mono
                wrap
              />
              <MetaRow
                icon={CalendarClock}
                label="Created"
                value={formatCreatedAt(database.createdAt)}
              />
            </InfoCard>

            {can("database.credentials.read") && database.hasCredentials ? (
              <DatabaseCredentialsCard
                key={`${database.relayId}:${database.id}`}
                canRotate={available && can("database.credentials.rotate")}
                database={database}
                networkRouteId={
                  can("database.network.read") ? routeId : undefined
                }
              />
            ) : null}

            {database.supportsImportExport &&
            database.hasCredentials &&
            available &&
            (can("database.dump.export") || can("database.dump.import")) ? (
              <DatabaseDataCard
                canExport={can("database.dump.export")}
                canImport={can("database.dump.import")}
                database={database}
              />
            ) : null}
          </div>

          <ResourceUsersCard
            noun="database"
            relayId={database.relayId}
            resourceId={database.id}
            resourceType="database"
          />
        </div>

        <InfoCard className="mt-4">
          <InfoCardHeader
            icon={<Network />}
            title="Relay placement"
            action={
              <StatusIndicator status={databaseStatusPresentation(database)} />
            }
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            <MetaRow
              icon={HardDrive}
              label="Relay"
              value={`${database.relayName} · ${database.relayId}`}
            />
            <MetaRow
              icon={Box}
              label="Container"
              value={database.containerId ?? "Not created"}
              mono
            />
            <MetaRow icon={Tags} label="Image" value={database.image} mono />
            <MetaRow icon={HardDrive} label="Status" value={database.status} />
          </div>
        </InfoCard>

        {can("database.delete") ? (
          <DatabaseDangerZone database={database} />
        ) : null}
      </div>
    </section>
  )
}

function DatabaseCredentialsCard({
  canRotate,
  database,
  networkRouteId,
}: {
  canRotate: boolean
  database: ManagedDatabase
  networkRouteId: string | undefined
}) {
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = React.useState(false)
  const credentialQueryKey = queryKeys.databases.credential(
    database.relayId,
    database.id
  )
  const credential = useQuery({
    ...managedDatabaseCredentialQueryOptions(database.relayId, database.id),
    enabled: revealed,
  })
  // Secrets stay in memory only while this page shows them.
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
      await queryClient.invalidateQueries({ queryKey: credentialQueryKey })
      showToast({ message: "Database password rotated", type: "success" })
    },
    onError: (error) =>
      showToast({
        message: `Password rotation failed: ${error.message}`,
        type: "error",
      }),
  })
  const address = `${database.hostname}:${database.internalPort}`

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<KeyRound />}
        title="Credentials"
        action={
          <div className="flex items-center gap-1">
            {networkRouteId ? (
              <Button asChild size="sm" variant="ghost">
                <Link
                  to="/db/$databaseId/network"
                  params={{ databaseId: networkRouteId }}
                >
                  Network
                  <ArrowRight />
                </Link>
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
          </div>
        }
      />
      <CopyMetaRow label="Internal address" value={address} />
      <CopyMetaRow label="Database" value={database.databaseName} />
      {!revealed ? (
        <p className="type-meta px-4 py-3 text-muted-foreground">
          Reveal to show the username, password, and connection URL. Servers
          reach this database only after you connect them on its network.
        </p>
      ) : credential.isPending ? (
        <div className="flex min-h-16 items-center justify-center">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : credential.isError ? (
        <p className="px-4 py-3 text-xs text-destructive">
          {credential.error.message}
        </p>
      ) : (
        <>
          <CopyMetaRow
            icon={User}
            label="Username"
            value={credential.data.username}
          />
          <CopyMetaRow
            icon={KeyRound}
            label="Password"
            value={credential.data.password}
            action={
              canRotate ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate()}
                >
                  {rotate.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <RotateCw />
                  )}
                  Rotate
                </Button>
              ) : null
            }
          />
          <CopyMetaRow
            icon={Globe2}
            label="Connection URL"
            value={databaseConnectionUrl(database, credential.data)}
          />
        </>
      )}
    </InfoCard>
  )
}

function DatabaseDataCard({
  canExport,
  canImport,
  database,
}: {
  canExport: boolean
  canImport: boolean
  database: ManagedDatabase
}) {
  const exportDump = useDatabaseExport(database)
  const [importOpen, setImportOpen] = React.useState(false)

  return (
    <>
      <InfoCard>
        <InfoCardHeader icon={<Database />} title="Data" />
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            Move data in and out as a SQL dump. Imports run against{" "}
            <span className="font-mono text-foreground">
              {database.databaseName}
            </span>{" "}
            without clearing existing data.
          </p>
          <div className="flex flex-wrap gap-2">
            {canExport ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={exportDump.isPending}
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
            {canImport ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setImportOpen(true)}
              >
                <Upload />
                Import SQL
              </Button>
            ) : null}
          </div>
        </div>
      </InfoCard>
      {importOpen ? (
        <ImportDatabaseDialog
          database={database}
          open
          onOpenChange={setImportOpen}
        />
      ) : null}
    </>
  )
}

function DatabaseDangerZone({ database }: { database: ManagedDatabase }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const leave = React.useCallback(() => {
    void navigate({ to: "/infra/databases", replace: true })
  }, [navigate])

  return (
    <>
      <DangerZone
        title="Delete this database"
        detail={database.id}
        action={
          <Button
            type="button"
            variant="destructive"
            className="shrink-0"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Delete database
          </Button>
        }
      />
      {open ? (
        <DeleteDatabaseDialog
          database={database}
          open
          onDeleted={leave}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
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
      : database.engine === "redis" || database.engine === "valkey"
        ? "redis"
        : "mysql"
  const path =
    scheme === "redis" ? "" : `/${encodeURIComponent(database.databaseName)}`
  return `${scheme}://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@${database.hostname}:${database.internalPort}${path}`
}

function formatCreatedAt(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? createdAtFormatter.format(new Date(timestamp))
    : value
}
