import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Copy, Globe, Globe2, LoaderCircle, Lock, Unplug } from "lucide-react"

import {
  databaseEngineRuntimes,
  databasePublicConnectionUrl,
  type RelayDatabasePublicStatus,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { managedDatabaseCredentialQueryOptions } from "@/lib/query-options"
import {
  closeManagedDatabasePublic,
  openManagedDatabasePublic,
} from "@/server/databases"

// Where opening the database stands, as its Relay says.
const stateLabels: Record<RelayDatabasePublicStatus["state"], string> = {
  failed: "Can't open",
  getting_certificate: "Getting its certificate",
  open: "Open",
  opening: "Opening",
  waiting_for_dns: "Waiting for its name to resolve",
}

/**
 * Opening the database to the internet: a name and a port anyone can reach
 * with TLS and its login, through a gate that refuses clients without TLS.
 */
export function DatabasePublicAccess({
  database,
}: {
  database: ManagedDatabase
}) {
  const [opening, setOpening] = React.useState(false)
  const canPublish =
    databaseRelayAvailable(database) &&
    database.permissions.includes("database.network.public-port.write")
  const status = database.public
  const queryClient = useQueryClient()
  const close = useMutation({
    mutationFn: () =>
      closeManagedDatabasePublic({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onError: (error) => showToast({ message: error.message, type: "error" }),
    onSuccess: () =>
      showToast({
        message: `${database.name} is private again`,
        type: "success",
      }),
  })

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Globe />}
        title="Public access"
        action={
          !canPublish ? null : status ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              {close.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Unplug />
              )}
              Close
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpening(true)}
            >
              <Globe2 />
              Open to the internet
            </Button>
          )
        }
      />
      {status ? (
        <>
          <CopyMetaRow label="Address" value={status.hostname} />
          <CopyMetaRow label="Port" value={String(status.port)} />
          <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <span
              className={
                status.state === "failed"
                  ? "text-right text-destructive"
                  : status.state === "open"
                    ? "text-right text-emerald-400 light:text-emerald-700"
                    : "text-right"
              }
            >
              {stateLabels[status.state]}
              {status.error ? (
                <span className="block text-xs text-muted-foreground">
                  {status.error}
                </span>
              ) : null}
            </span>
          </div>
          {status.certificateExpiresAt ? (
            <CopyMetaRow
              copyable={false}
              icon={Lock}
              label="Certificate"
              value={`Let's Encrypt, until ${new Date(status.certificateExpiresAt).toLocaleDateString()}`}
            />
          ) : null}
          <PublicConnectionUrl
            database={database}
            onFetch={() =>
              queryClient.fetchQuery(
                managedDatabaseCredentialQueryOptions(
                  database.relayId,
                  database.id
                )
              )
            }
            status={status}
          />
        </>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Only Kiln&apos;s private networks and tunnels reach {database.name}.
          Opening it gives it a name and a port anyone can reach with TLS and
          its login.
        </p>
      )}
      {opening ? (
        <OpenPublicDialog database={database} onOpenChange={setOpening} />
      ) : null}
    </InfoCard>
  )
}

// Copies a connection URL that checks the database's certificate, as many
// clients don't unless they're told to; its password is read as it's
// copied.
function PublicConnectionUrl({
  database,
  onFetch,
  status,
}: {
  database: ManagedDatabase
  onFetch: () => Promise<{ password: string; username: string }>
  status: RelayDatabasePublicStatus
}) {
  const [copied, setCopied] = React.useState(false)
  const canRead = database.permissions.includes("database.credentials.read")
  if (!canRead) return null
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
      <span className="text-muted-foreground">Connection URL</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={async () => {
          const login = await onFetch()
          await navigator.clipboard.writeText(
            databasePublicConnectionUrl({
              databaseName: database.databaseName,
              engine: database.engine,
              host: status.hostname,
              password: encodeURIComponent(login.password),
              port: status.port,
              username: login.username,
            })
          )
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1_800)
        }}
      >
        <Copy />
        {copied ? "Copied" : "Copy, with TLS checked"}
      </Button>
    </div>
  )
}

function OpenPublicDialog({
  database,
  onOpenChange,
}: {
  database: ManagedDatabase
  onOpenChange: (open: boolean) => void
}) {
  const [port, setPort] = React.useState(
    String(databaseEngineRuntimes[database.engine].port)
  )
  const open = useMutation({
    mutationFn: () =>
      openManagedDatabasePublic({
        data: {
          databaseId: database.id,
          port: Number(port),
          relayId: database.relayId,
        },
      }),
    onSuccess: ({ hostname }) => {
      showToast({
        message: `${database.name} opens at ${hostname} once its certificate comes`,
        type: "success",
      })
      onOpenChange(false)
    },
  })
  const valid =
    /^\d{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65_535
  return (
    <Dialog open onOpenChange={(next) => !open.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open {database.name} to the internet?</DialogTitle>
          <DialogDescription>
            Kiln gives it a name under your default vanity domain, gets its
            certificate, and restarts it once. Clients must use TLS, and anyone
            with its login can connect.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Port on {database.relayName}</span>
          <Input
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value.trim())}
          />
        </label>
        {open.error ? (
          <p className="text-xs text-destructive">{open.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={open.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={open.isPending || !valid}
            onClick={() => open.mutate()}
          >
            {open.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Globe2 />
            )}
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
