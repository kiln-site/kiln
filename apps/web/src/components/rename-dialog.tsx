import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, LoaderCircle, Pencil } from "lucide-react"

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

// Rename, for an Info section's actions. The dialog mounts only while open.
export function RenameButton({
  disabledReason,
  ...dialog
}: Omit<React.ComponentProps<typeof RenameDialog>, "onOpenChange"> & {
  // Why it can't rename right now, such as a disconnected Relay.
  disabledReason?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => setOpen(true)}
      >
        <Pencil />
        Rename
      </Button>
      {open ? <RenameDialog {...dialog} onOpenChange={setOpen} /> : null}
    </>
  )
}

function RenameDialog({
  id,
  maxLength,
  name: currentName,
  noun,
  onOpenChange,
  rename,
}: {
  // Keeps the field's id unique on the page.
  id: string
  maxLength: number
  name: string
  // Lowercase, for example "server".
  noun: string
  onOpenChange: (open: boolean) => void
  rename: (name: string) => Promise<unknown>
}) {
  const [name, setName] = React.useState(currentName)
  const [error, setError] = React.useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: rename,
    onSuccess: () => {
      showToast({
        message: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} renamed`,
        type: "success",
      })
      onOpenChange(false)
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : `Could not rename the ${noun}`
      ),
  })
  const nextName = name.trim()
  const unchanged = !nextName || nextName === currentName

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (unchanged || mutation.isPending) return
    setError(null)
    mutation.mutate(nextName)
  }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => !mutation.isPending && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename {noun}</DialogTitle>
          <DialogDescription>
            The name can change without changing the {noun} ID.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <label
              htmlFor={`rename-${id}`}
              className="type-label block text-muted-foreground"
            >
              Name
            </label>
            <Input
              id={`rename-${id}`}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              maxLength={maxLength}
              disabled={mutation.isPending}
              aria-invalid={Boolean(error)}
              autoFocus
              required
            />
            {error ? (
              <p className="type-meta text-destructive">{error}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={unchanged || mutation.isPending}>
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
