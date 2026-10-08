import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Database,
  Eye,
  EyeOff,
  Hash,
  KeyRound,
  LoaderCircle,
  Server,
  User,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

import type { ManagedDatabase } from "@/components/database/database-presentation"
import { CopyMetaRow } from "@/components/info-card"
import { WorkspaceToolbarTooltip } from "@/components/workspace-toolbar-tooltip"
import {
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"

// A toolbar button that shows the database's connection details to copy.
export function DatabaseCredentialsPopover({
  database,
}: {
  database: Pick<
    ManagedDatabase,
    "databaseName" | "hostname" | "id" | "internalPort" | "relayId"
  >
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WorkspaceToolbarTooltip content="Credentials">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Credentials"
          >
            <KeyRound className="size-4" />
          </Button>
        </PopoverTrigger>
      </WorkspaceToolbarTooltip>
      <PopoverContent align="end" className="w-80 p-0">
        {open ? <CredentialRows database={database} /> : null}
      </PopoverContent>
    </Popover>
  )
}

function CredentialRows({
  database,
}: {
  database: Pick<
    ManagedDatabase,
    "databaseName" | "hostname" | "id" | "internalPort" | "relayId"
  >
}) {
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = React.useState(false)
  const credential = useQuery(
    managedDatabaseCredentialQueryOptions(database.relayId, database.id)
  )
  // Secrets stay in memory only while the popover shows them.
  React.useEffect(
    () => () => {
      queryClient.removeQueries({
        exact: true,
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
    },
    [database.id, database.relayId, queryClient]
  )

  return (
    <>
      <CopyMetaRow icon={Server} label="Host" value={database.hostname} />
      <CopyMetaRow
        icon={Hash}
        label="Port"
        value={String(database.internalPort)}
      />
      <CopyMetaRow
        icon={Database}
        label="Database"
        value={database.databaseName}
      />
      {credential.isPending ? (
        <div className="flex min-h-32 items-center justify-center">
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
            display={revealed ? credential.data.password : "••••••••••••"}
            action={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={revealed ? "Hide password" : "Reveal password"}
                aria-pressed={revealed}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? <EyeOff /> : <Eye />}
              </Button>
            }
          />
        </>
      )}
    </>
  )
}
