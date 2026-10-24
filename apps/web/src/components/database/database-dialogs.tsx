import { instanceInventoryScope } from "@/lib/instance-inventory"
import { useInstanceState } from "@/lib/instance-state"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  Copy,
  Eraser,
  LoaderCircle,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react"

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

import { databaseFileRootId } from "@workspace/contracts"

import {
  showDatabaseOperationError,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { downloadRelayFile, uploadRelayFile } from "@/lib/relay-file-transfer"
import {
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  deleteManagedDatabase,
  exportManagedDatabase,
  importManagedDatabase,
  rotateManagedDatabasePassword,
  wipeManagedDatabase,
} from "@/server/databases"

export function CredentialsDialog({
  database,
  open,
  onOpenChange,
}: {
  database: Pick<
    ManagedDatabase,
    "id" | "name" | "relayId" | "permissions" | "engine" | "databaseName"
  >
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const state = useInstanceState({
    kind: "database",
    id: database.id,
    relayId: database.relayId,
  })
  const credential = useQuery(
    managedDatabaseCredentialQueryOptions(database.relayId, database.id)
  )
  const close = React.useCallback(() => {
    queryClient.removeQueries({
      exact: true,
      queryKey: queryKeys.databases.credential(database.relayId, database.id),
    })
    onOpenChange(false)
  }, [database.id, database.relayId, onOpenChange, queryClient])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Credentials</DialogTitle>
          <DialogDescription>
            Use these values from a server connected to {database.name}'s
            private network.
          </DialogDescription>
        </DialogHeader>
        {credential.isPending ? (
          <div className="flex min-h-40 items-center justify-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : credential.error ? (
          <p className="text-xs text-destructive">{credential.error.message}</p>
        ) : credential.data ? (
          <div className="space-y-3">
            {credential.data.hostname !== undefined ? (
              <>
                <CredentialField
                  label="Host"
                  value={credential.data.hostname}
                />
                <div className="grid grid-cols-2 gap-3">
                  <CredentialField
                    label="Port"
                    value={String(credential.data.internalPort)}
                  />
                  <CredentialField
                    label="Database"
                    value={credential.data.databaseName}
                  />
                </div>
              </>
            ) : (
              <CredentialField
                label="Database"
                value={credential.data.databaseName}
              />
            )}
            <CredentialField
              label="Username"
              value={credential.data.username}
            />
            <CredentialField
              label="Password"
              value={credential.data.password}
              secret
            />
          </div>
        ) : null}
        <DialogFooter className="sm:justify-between">
          {state.phase === "ready" &&
          state.observation.reachability === "connected" &&
          state.observation.inventory === "available" &&
          database.permissions.includes("database.credentials.rotate") ? (
            <RotateDatabasePasswordButton database={database} />
          ) : (
            <span />
          )}
          <Button type="button" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Rotate password, confirmed first: anything still using the old password,
// like a game server's config, loses access until it gets the new one.
export function RotateDatabasePasswordButton({
  database,
  disabledReason,
  size = "default",
}: {
  database: Pick<ManagedDatabase, "id" | "name" | "relayId">
  disabledReason?: string
  size?: "default" | "sm"
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => setOpen(true)}
      >
        <RotateCw />
        Rotate Password
      </Button>
      {open ? (
        <RotateDatabasePasswordDialog
          database={database}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function RotateDatabasePasswordDialog({
  database,
  onOpenChange,
}: {
  database: Pick<ManagedDatabase, "id" | "name" | "relayId">
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
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
      onOpenChange(false)
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => !rotate.isPending && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate {database.name}&apos;s password?</DialogTitle>
          <DialogDescription>
            The database gets a new password right away. Anything still using
            the current one, like a game server&apos;s config, can&apos;t
            connect until you give it the new password.
          </DialogDescription>
        </DialogHeader>
        {rotate.error ? (
          <p className="text-xs text-destructive">{rotate.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Rotate Password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CredentialField({
  label,
  secret = false,
  value,
}: {
  label: string
  secret?: boolean
  value: string
}) {
  const [revealed, setRevealed] = React.useState(!secret)
  return (
    <label className="block">
      <span className="type-technical-label mb-1.5 block text-muted-foreground">
        {label}
      </span>
      <div className="flex gap-1.5">
        <Input
          className="font-mono text-xs"
          readOnly
          type={revealed ? "text" : "password"}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
        />
        {secret ? (
          <Button
            aria-label={revealed ? "Hide password" : "Reveal password"}
            type="button"
            variant="outline"
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        ) : null}
        <Button
          aria-label={`Copy ${label.toLowerCase()}`}
          size="icon"
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            showToast({ message: `${label} copied`, type: "success" })
          }}
        >
          <Copy />
        </Button>
      </div>
    </label>
  )
}

export function ImportDatabaseDialog({
  database,
  initialFile = null,
  open,
  onOpenChange,
}: {
  database: Pick<
    ManagedDatabase,
    "id" | "name" | "relayId" | "permissions" | "engine" | "databaseName"
  >
  // A file already chosen, such as one dropped on the Info page.
  initialFile?: File | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = React.useState<File | null>(initialFile)
  // How much of the dump has reached the Relay, until it all has.
  const [uploaded, setUploaded] = React.useState<number | null>(null)
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a SQL dump first")
      await checkDatabaseDump(file, database.engine)
      // Sent as files are, to the database's dump folder on its Relay, under
      // a name of its own, then run from there.
      const fileName = `import-${crypto.randomUUID()}`
      await uploadRelayFile({
        file,
        instanceId: databaseFileRootId(database.id),
        onProgress: setUploaded,
        path: fileName,
        relayId: database.relayId,
      })
      setUploaded(null)
      return importManagedDatabase({
        data: { databaseId: database.id, fileName, relayId: database.relayId },
      })
    },
    onSettled: () => setUploaded(null),
    onSuccess: () => {
      showToast({
        message: `Imported ${file?.name ?? "SQL dump"}`,
        type: "success",
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import SQL dump</DialogTitle>
          <DialogDescription>
            The dump runs against {database.databaseName}. Existing data is not
            cleared first.
          </DialogDescription>
        </DialogHeader>
        <label className="block rounded-lg border border-dashed border-border p-4 text-center">
          <Upload className="mx-auto size-5 text-muted-foreground" />
          <span className="mt-2 block text-xs font-medium">
            {file?.name ?? "Choose a .sql or .dmp file"}
          </span>
          <span className="type-meta mt-1 block text-muted-foreground">
            {database.engine === "postgres"
              ? "Text dumps, or custom-format dumps from pg_dump -Fc"
              : "Text dumps from mysqldump or mariadb-dump"}
          </span>
          <input
            accept={DATABASE_DUMP_ACCEPT}
            className="sr-only"
            type="file"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null)
            }}
          />
        </label>
        {upload.error ? (
          <p className="text-xs text-destructive">{upload.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!file || upload.isPending}
            type="button"
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Upload />
            )}
            {uploaded !== null && file
              ? `Uploading ${Math.floor((uploaded / Math.max(file.size, 1)) * 100)}%`
              : upload.isPending
                ? "Importing"
                : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// What the file pickers offer. Dropped files of any name are read the same
// way.
export const DATABASE_DUMP_ACCEPT = ".sql,.dmp,application/sql,text/plain"

// A text dump, or a PostgreSQL custom-format dump (pg_dump -Fc), which starts
// with "PGDMP" and goes through pg_restore. Any other binary file isn't a
// dump we can import. Only the start of the file is read, however large.
async function checkDatabaseDump(
  file: File,
  engine: ManagedDatabase["engine"]
): Promise<void> {
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "PGDMP") {
    if (engine !== "postgres") {
      throw new Error(
        "This is a PostgreSQL custom-format dump, which only a PostgreSQL database can import"
      )
    }
    return
  }
  if (bytes.includes(0)) {
    throw new Error(
      "This file isn't a text SQL dump or a PostgreSQL custom-format dump"
    )
  }
}

// Deletes every table and row and keeps the database, its login, and its
// connections. Confirmed the way deleting is.
export function WipeDatabaseDialog({
  database,
  onOpenChange,
}: {
  database: Pick<
    ManagedDatabase,
    "id" | "name" | "relayId" | "permissions" | "engine" | "databaseName"
  >
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const wipe = useMutation({
    mutationFn: () =>
      wipeManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({
            kind: "database",
            relayId: database.relayId,
            id: database.id,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.databases.container(
            database.relayId,
            database.id
          ),
        }),
      ])
      showToast({ message: `${database.name} wiped`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => !wipe.isPending && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Wipe {database.name}?</DialogTitle>
          <DialogDescription>
            Every table and row will be permanently deleted. The database, its
            credentials, and its game server connections stay.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          This action cannot be undone. Export a SQL dump first if you need a
          recovery copy.
        </div>
        {wipe.error ? (
          <p className="text-xs text-destructive">{wipe.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={wipe.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={wipe.isPending}
            type="button"
            variant="destructive"
            onClick={() => wipe.mutate()}
          >
            {wipe.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Eraser />
            )}
            Wipe database
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteDatabaseDialog({
  database,
  open,
  onDeleted,
  onOpenChange,
}: {
  database: Pick<
    ManagedDatabase,
    "id" | "name" | "relayId" | "permissions" | "engine" | "databaseName"
  >
  open: boolean
  // Runs before the database lists refresh, so a page showing the database
  // can leave first.
  onDeleted?: () => void
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () =>
      deleteManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: async () => {
      onDeleted?.()
      queryClient.removeQueries({
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.all,
      })
      showToast({ message: `${database.name} deleted`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {database.name}?</DialogTitle>
          <DialogDescription>
            The container, isolated network, persistent data volume,
            credentials, and access grants will be permanently removed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          This action cannot be undone. Export a SQL dump first if you need a
          recovery copy.
        </div>
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete database
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function useDatabaseExport(
  database: Pick<ManagedDatabase, "id" | "name" | "relayId">
) {
  return useMutation({
    // The Relay writes the dump to the database's dump folder, which the
    // browser then downloads as it does other files.
    mutationFn: async () => {
      const exported = await exportManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      })
      await downloadRelayFile({
        compression: "none",
        instanceId: databaseFileRootId(database.id),
        name: exported.fileName,
        path: exported.path,
        relayId: database.relayId,
      })
    },
    onSuccess: () => {
      showToast({ message: `Exported ${database.name}`, type: "success" })
    },
    onError: (error) => showDatabaseOperationError("Export failed", error),
  })
}
