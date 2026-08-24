import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import { Check, Copy, LoaderCircle, Trash2, TriangleAlert } from "lucide-react"

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

import { copyTextToClipboard } from "@/lib/clipboard"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { queryKeys, type RelayConnection } from "@/lib/query-options"
import { deleteInstance } from "@/server/relay"

export interface ServerDeleteTarget {
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
  const deletion = useMutation({
    mutationFn: deleteInstance,
    onSuccess: () => removeDeletedInstanceFromCache(queryClient, target),
  })
  const pending = deletion.isPending
  const confirmed = confirmation === target.id

  const changeOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (pending) return
      onOpenChange(nextOpen)
    },
    [onOpenChange, pending]
  )

  async function copyServerId() {
    const copiedId = await copyTextToClipboard(target.id)
    if (!copiedId) {
      setError("Could not copy the server ID. Select and copy it manually.")
      return
    }
    setCopied(true)
    setError(null)
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
              instanceId: target.id,
              password,
              relayId: target.relayId,
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
      description: "The server and its stored data were removed.",
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
            its managed server directory. This cannot be undone.
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

          <p
            role={error ? "alert" : undefined}
            className={`type-meta min-h-4 ${
              error ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {error ??
              (confirmation.length > 0 && !confirmed
                ? "The pasted server ID does not match."
                : passwordRequired
                  ? "Both confirmations are checked again by Hearth before deletion."
                  : "The server ID is checked again by Hearth before deletion.")}
          </p>

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

function removeDeletedInstanceFromCache(
  queryClient: QueryClient,
  target: ServerDeleteTarget
): void {
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) =>
      snapshot ? removeDeletedInstance(snapshot, target) : undefined
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      connection?.status === "connected"
        ? {
            ...connection,
            snapshot: removeDeletedInstance(connection.snapshot, target),
          }
        : connection
  )
}

function removeDeletedInstance(
  snapshot: RelayFleetSnapshot,
  target: ServerDeleteTarget
): RelayFleetSnapshot {
  return {
    ...snapshot,
    instances: snapshot.instances.filter(
      (instance) =>
        instance.id !== target.id || instance.relayId !== target.relayId
    ),
  }
}
