import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import {
  Archive,
  Check,
  Copy,
  LoaderCircle,
  Trash2,
  TriangleAlert,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"

import { backupStorageQueryOptions } from "@/lib/query-options"
import { applyDeletedInstance } from "@/lib/realtime-client"
import { deleteInstance } from "@/server/relay"

export interface ServerDeleteTarget {
  backupAvailable: boolean
  id: string
  name: string
  relayId: string
}

export const ServerDeleteDialog = React.memo(function ServerDeleteDialog({
  open,
  target,
  onDeleted,
  onOpenChange,
  passwordRequired = true,
}: {
  open: boolean
  target: ServerDeleteTarget
  onDeleted?: () => Promise<void> | void
  onOpenChange: (open: boolean) => void
  passwordRequired?: boolean
}) {
  const queryClient = useQueryClient()
  const [confirmation, setConfirmation] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [createBackup, setCreateBackup] = React.useState(target.backupAvailable)
  const [backupDestination, setBackupDestination] = React.useState("default")
  const deletion = useMutation({
    mutationFn: deleteInstance,
    onSuccess: () =>
      applyDeletedInstance(queryClient, {
        instanceId: target.id,
        relayId: target.relayId,
      }),
  })
  const pending = deletion.isPending
  const confirmed = confirmation === target.id
  const changeCreateBackup = React.useCallback((nextCreateBackup: boolean) => {
    setCreateBackup(nextCreateBackup)
    setError(null)
  }, [])

  const changeOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (pending) return
      onOpenChange(nextOpen)
    },
    [onOpenChange, pending]
  )

  async function copyServerId() {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(target.id),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () =>
            setError(
              "Could not copy the server ID. Select and copy it manually."
            ),
          onSuccess: () => {
            setCopied(true)
            setError(null)
          },
        })
      )
    )
  }

  async function removeServer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmed || (passwordRequired && !password) || pending) return
    setError(null)
    const deleted = await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          deletion.mutateAsync({
            data: {
              confirmation,
              createBackup,
              instanceId: target.id,
              password,
              relayId: target.relayId,
              ...(createBackup && backupDestination !== "default"
                ? {
                    storageId:
                      backupDestination === "local" ? null : backupDestination,
                  }
                : {}),
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not delete the server."
            )
            return false
          },
          onSuccess: () => true,
        })
      )
    )
    if (!deleted) return

    showToast({
      type: "success",
      message: `${target.name} deleted`,
      description: createBackup
        ? "The final backup was saved and the server data was removed."
        : "The server and its stored data were removed without a final backup.",
      duration: 5_000,
    })
    onOpenChange(false)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => onDeleted?.(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => window.location.assign("/infra/servers"))
        )
      )
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!pending}>
        <DialogHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4" />
          </div>
          <DialogTitle>Delete {target.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the server, its container, and all data in
            its managed server directory.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => void removeServer(event)}
        >
          <div className="grid gap-2">
            <span className="type-technical-label text-muted-foreground">
              Server ID
            </span>
            <button
              type="button"
              className="group flex min-w-0 items-center gap-3 rounded-lg border border-border/80 bg-background/55 px-3 py-2.5 text-left transition-colors outline-none hover:border-destructive/30 hover:bg-destructive/5 focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/35"
              aria-label="Copy server ID"
              onClick={() => void copyServerId()}
            >
              <code className="type-code min-w-0 flex-1 break-all text-foreground">
                {target.id}
              </code>
              <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground group-hover:text-foreground">
                {copied ? (
                  <Check className="size-3.5 text-emerald-400" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </span>
            </button>
            <p className="type-meta text-muted-foreground">
              {copied
                ? "Copied. Paste the full ID below to continue."
                : "Click the ID to copy it, then paste it below."}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label
              htmlFor="delete-server-id-confirmation"
              className="type-technical-label text-muted-foreground"
            >
              Paste server ID
            </label>
            <Input
              id="delete-server-id-confirmation"
              aria-label="Paste server ID"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.currentTarget.value)
                setError(null)
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={confirmation.length > 0 && !confirmed}
              className="bg-background font-mono text-xs"
              disabled={pending}
              required
            />
          </div>

          <FinalBackupFields
            available={target.backupAvailable}
            createBackup={createBackup}
            destination={backupDestination}
            open={open}
            pending={pending}
            onCreateBackupChange={changeCreateBackup}
            onDestinationChange={setBackupDestination}
          />

          {passwordRequired ? (
            <div className="grid gap-1.5">
              <label
                htmlFor="delete-server-password"
                className="type-technical-label text-muted-foreground"
              >
                Account password
              </label>
              <Input
                id="delete-server-password"
                aria-label="Account password"
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value)
                  setError(null)
                }}
                autoComplete="current-password"
                placeholder="Enter your account password"
                className="bg-background"
                disabled={pending}
                required
              />
            </div>
          ) : null}

          {error || (confirmation.length > 0 && !confirmed) ? (
            <p
              role={error ? "alert" : undefined}
              className="type-meta text-destructive"
            >
              {error ?? "The pasted server ID does not match."}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={
                !confirmed || (passwordRequired && !password) || pending
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {pending ? "Deleting server…" : "Delete server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

const FinalBackupFields = React.memo(function FinalBackupFields({
  available,
  createBackup,
  destination,
  open,
  pending,
  onCreateBackupChange,
  onDestinationChange,
}: {
  available: boolean
  createBackup: boolean
  destination: string
  open: boolean
  pending: boolean
  onCreateBackupChange: (createBackup: boolean) => void
  onDestinationChange: (destination: string) => void
}) {
  const backupStorage = useQuery({
    ...backupStorageQueryOptions(),
    enabled: open && available && createBackup,
  })
  const availableStorage = React.useMemo(
    () =>
      (backupStorage.data ?? []).filter(
        (candidate) => candidate.enabled && !candidate.deleting
      ),
    [backupStorage.data]
  )

  return (
    <div className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
      <label
        className={`flex items-start gap-3 ${
          available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
        }`}
      >
        <input
          aria-label="Back up server before deleting"
          checked={createBackup}
          className="mt-0.5 size-4 rounded-[3px] border-input accent-primary"
          disabled={!available || pending}
          type="checkbox"
          onChange={(event) =>
            onCreateBackupChange(event.currentTarget.checked)
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Archive className="size-4 text-muted-foreground" />
            Back up server before deleting
          </span>
          {available ? null : (
            <span className="type-meta mt-1 block text-muted-foreground">
              Unavailable because this server never finished provisioning.
            </span>
          )}
        </span>
      </label>

      <label className="grid gap-1.5 border-t border-border/70 pt-3">
        <span className="type-technical-label text-muted-foreground">
          Backup destination
        </span>
        <Select
          disabled={!available || !createBackup || pending}
          value={destination}
          onValueChange={onDestinationChange}
        >
          <SelectTrigger
            aria-label="Backup destination"
            className="h-9 w-full bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-(--radix-select-trigger-width)">
            <SelectItem value="default">
              Default · Preferred destination
            </SelectItem>
            <SelectItem value="local">Local Relay</SelectItem>
            {availableStorage.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                S3 · {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
})
