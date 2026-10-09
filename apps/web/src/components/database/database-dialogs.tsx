import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  Copy,
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

import {
  databaseRelayAvailable,
  DATABASE_DUMP_LIMIT_BYTES,
  downloadTextFile,
  showDatabaseOperationError,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import {
  managedDatabaseCredentialQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  deleteManagedDatabase,
  exportManagedDatabase,
  importManagedDatabase,
  rotateManagedDatabasePassword,
} from "@/server/databases"

export function CredentialsDialog({
  database,
  open,
  onOpenChange,
}: {
  database: ManagedDatabase
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
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
  })

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
            {database.inventoryStatus === "available" ? (
              <>
                <CredentialField label="Host" value={database.hostname} />
                <div className="grid grid-cols-2 gap-3">
                  <CredentialField
                    label="Port"
                    value={String(database.internalPort)}
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
        {rotate.error ? (
          <p className="text-xs text-destructive">{rotate.error.message}</p>
        ) : null}
        <DialogFooter className="sm:justify-between">
          {databaseRelayAvailable(database) &&
          database.permissions.includes("database.credentials.rotate") ? (
            <Button
              disabled={rotate.isPending}
              type="button"
              variant="outline"
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              Rotate password
            </Button>
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
  open,
  onOpenChange,
}: {
  database: ManagedDatabase
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a SQL dump first")
      if (file.size > DATABASE_DUMP_LIMIT_BYTES) {
        throw new Error("SQL dumps are currently limited to 700 KB")
      }
      return importManagedDatabase({
        data: {
          content: await file.text(),
          databaseId: database.id,
          relayId: database.relayId,
        },
      })
    },
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
            Statements run against {database.databaseName}. Existing data is not
            cleared first. Current upload limit: 700 KB.
          </DialogDescription>
        </DialogHeader>
        <label className="block rounded-lg border border-dashed border-border p-4 text-center">
          <Upload className="mx-auto size-5 text-muted-foreground" />
          <span className="mt-2 block text-xs font-medium">
            {file?.name ?? "Choose a .sql file"}
          </span>
          <span className="type-meta mt-1 block text-muted-foreground">
            MySQL, MariaDB, and PostgreSQL text dumps
          </span>
          <input
            accept=".sql,application/sql,text/plain"
            className="sr-only"
            type="file"
            onChange={(event) => {
              const next = event.currentTarget.files?.[0] ?? null
              setFile(next)
              setLocalError(
                next && next.size > DATABASE_DUMP_LIMIT_BYTES
                  ? "SQL dumps are currently limited to 700 KB"
                  : null
              )
            }}
          />
        </label>
        {localError || upload.error ? (
          <p className="text-xs text-destructive">
            {localError ?? upload.error?.message}
          </p>
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
            disabled={!file || Boolean(localError) || upload.isPending}
            type="button"
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Upload />
            )}
            Import
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
  database: ManagedDatabase
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
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
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
    mutationFn: () =>
      exportManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: (result) => {
      downloadTextFile(result.fileName, result.content)
      showToast({ message: `Exported ${database.name}`, type: "success" })
    },
    onError: (error) => showDatabaseOperationError("Export failed", error),
  })
}
