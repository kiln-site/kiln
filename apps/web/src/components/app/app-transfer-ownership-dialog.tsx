import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRightLeft, LoaderCircle } from "lucide-react"

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

import { transferAppOwnership } from "@/server/access"

// Hands an app to someone else. They're named by email, so the owner doesn't
// see who else can reach the Relay.
export function AppTransferOwnershipDialog({
  appId,
  open,
  relayId,
  onOpenChange,
}: {
  appId: string
  open: boolean
  relayId: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [email, setEmail] = React.useState("")
  const transfer = useMutation({
    mutationFn: () =>
      transferAppOwnership({ data: { appId, email, relayId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["app-owner", relayId, appId],
      })
      showToast({ message: "Ownership transferred", type: "success" })
      onOpenChange(false)
      setEmail("")
    },
  })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!transfer.isPending) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            transfer.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Transfer ownership?</DialogTitle>
            <DialogDescription>
              They become the app's owner, who can see it and its logs, delete
              it, and hand it on. They need access to its Relay. Your remaining
              access follows your Relay permissions.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="New owner's email"
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            required
            type="email"
            value={email}
          />
          {transfer.error ? (
            <p className="text-xs text-destructive">{transfer.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={transfer.isPending}
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={transfer.isPending || !email.trim()}
              type="submit"
              variant="destructive"
            >
              {transfer.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowRightLeft />
              )}
              Transfer ownership
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
