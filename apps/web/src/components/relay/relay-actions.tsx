import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import {
  ArchiveX,
  Cloud,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
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
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { RelayToastTitle } from "@/components/relay-toast-title"
import { forkPromise } from "@/effect/promise"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import { queryKeys } from "@/lib/query-options"
import type { PersistedRelay } from "@/lib/relay-registry"
import { removeRelay, setRelayEnabled } from "@/server/relays"

// Pausing, resuming, and removing a Relay, from the Relays table or the
// Relay's own pages.

const pendingRelayResumes = new Map<string, Promise<void>>()

export const RelayPauseButton = React.memo(function RelayPauseButton({
  relay,
}: {
  relay: RelayPauseTarget
}) {
  const { pending, toggle } = useRelayPauseToggle(relay)
  const [confirming, setConfirming] = React.useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`${relay.enabled ? "Pause" : "Resume"} ${relay.name}`}
            disabled={pending}
            className="text-muted-foreground hover:text-foreground"
            onClick={() =>
              relay.enabled ? setConfirming(true) : void toggle()
            }
          >
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : relay.enabled ? (
              <Pause />
            ) : (
              <Play />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {relay.enabled ? "Pause" : "Resume"}
        </TooltipContent>
      </Tooltip>
      {confirming ? (
        <RelayPauseDialog relay={relay} onClose={() => setConfirming(false)} />
      ) : null}
    </>
  )
})

// Mounted only while open.
export function RelayPauseDialog({
  relay,
  onClose,
}: {
  relay: RelayPauseTarget
  onClose: () => void
}) {
  const { pending, toggle } = useRelayPauseToggle(relay)

  async function pause() {
    await toggle()
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Pause {relay.name}?</DialogTitle>
          <DialogDescription>
            Game servers keep running, but nothing on this Relay changes until
            you resume it: no power or file changes, schedules, backups, or
            crash recovery.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={pending} type="button" onClick={() => void pause()}>
            {pending ? <LoaderCircle className="animate-spin" /> : <Pause />}
            Pause Relay
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface RelayPauseTarget {
  enabled: boolean
  id: string
  name: string
}

export function useRelayPauseToggle(relay: RelayPauseTarget) {
  const queryClient = useQueryClient()
  const pendingRef = React.useRef(false)
  const [pending, setPending] = React.useState(false)

  async function togglePaused() {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    const relayIdentity = { id: relay.id, name: relay.name }
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          relay.enabled
            ? pauseRelay(queryClient, relayIdentity)
            : resumeRelay(queryClient, relayIdentity),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            showRelayError(
              cause,
              relay.enabled ? "Could not pause Relay" : "Could not resume Relay"
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingRef.current = false
            setPending(false)
          })
        )
      )
    )
  }

  return { pending, toggle: togglePaused }
}

export const RelayDeleteButton = React.memo(function RelayDeleteButton({
  relayId,
  name,
}: {
  relayId: string
  name: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${name}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Remove
        </TooltipContent>
      </Tooltip>
      {open ? (
        <RemoveRelayDialog
          name={name}
          relayId={relayId}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
})

// Mounted only while open, so each opening starts with both options checked.
export function RemoveRelayDialog({
  name,
  relayId,
  onOpenChange,
  onRemoved,
}: {
  name: string
  relayId: string
  onOpenChange: (open: boolean) => void
  onRemoved?: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const pendingRef = React.useRef(false)
  const [pending, setPending] = React.useState(false)
  const [forgetBackups, setForgetBackups] = React.useState(true)
  const [removeVanityDomains, setRemoveVanityDomains] = React.useState(true)
  const removeMutation = useMutation({
    mutationFn: removeRelay,
    onSuccess: async () => {
      // Leave the Relay's pages before it disappears from the cache, so they
      // don't flash as unavailable.
      await onRemoved?.()
      queryClient.setQueryData<Array<PersistedRelay>>(
        queryKeys.relays,
        (current) => current?.filter((item) => item.id !== relayId)
      )
      await Promise.all([
        invalidateRelayRuntimeQueries(queryClient),
        resetActiveBackupRunsToFirstPage(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.databases.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.capabilities,
        }),
      ])
    },
  })

  async function remove() {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          removeMutation.mutateAsync({
            data: { forgetBackups, id: relayId, removeVanityDomains },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            dismissToast(relayPausedToastId(relayId))
            dismissToast(relayResumedToastId(relayId))
            dismissToast(relayResumeErrorToastId(relayId))
            onOpenChange(false)
            showToast({
              message:
                result.cleanupFailures.length > 0
                  ? `${name} removed, but some Hearth cleanup could not be completed`
                  : `${name} removed from Hearth`,
              type: result.cleanupFailures.length > 0 ? "warning" : "success",
            })
          })
        ),
        Effect.catch((cause) =>
          Effect.sync(() => showRelayError(cause, "Could not remove Relay"))
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingRef.current = false
            setPending(false)
          })
        )
      )
    )
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
          <DialogDescription>
            Hearth will stop managing this Relay. Nothing on the Relay itself
            will be changed or deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background/35 p-3 transition-colors hover:bg-muted/25 has-checked:border-primary/35 has-checked:bg-primary/[0.06]">
            <input
              aria-describedby={`forget-backups-description-${relayId}`}
              checked={forgetBackups}
              className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
              disabled={pending}
              type="checkbox"
              onChange={(event) => setForgetBackups(event.target.checked)}
            />
            <ArchiveX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                Forget all backups
              </span>
              <span
                id={`forget-backups-description-${relayId}`}
                className="mt-0.5 block text-xs leading-5 text-muted-foreground"
              >
                Remove backup history from Hearth. Stored backup files on the
                Relay are not deleted.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background/35 p-3 transition-colors hover:bg-muted/25 has-checked:border-primary/35 has-checked:bg-primary/[0.06]">
            <input
              aria-describedby={`remove-domains-description-${relayId}`}
              checked={removeVanityDomains}
              className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
              disabled={pending}
              type="checkbox"
              onChange={(event) => setRemoveVanityDomains(event.target.checked)}
            />
            <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                Remove vanity domains
              </span>
              <span
                id={`remove-domains-description-${relayId}`}
                className="mt-0.5 block text-xs leading-5 text-muted-foreground"
              >
                Delete this Relay’s managed DNS records from Cloudflare. Nothing
                changes on the Relay.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="ghost"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending}
            type="button"
            variant="destructive"
            onClick={() => void remove()}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Remove Relay
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function updateRelayCache(
  queryClient: QueryClient,
  updatedRelays: Array<PersistedRelay>
) {
  if (updatedRelays.length === 0) return
  const updates = new Map(updatedRelays.map((relay) => [relay.id, relay]))
  queryClient.setQueryData<Array<PersistedRelay>>(
    queryKeys.relays,
    (current) =>
      current?.map((relay) => {
        const update = updates.get(relay.id)
        return update ? { ...relay, ...update } : relay
      }) ?? updatedRelays
  )
}

export async function invalidateRelayRuntimeQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.relay.connection,
      exact: true,
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.relay.snapshot,
      exact: true,
    }),
  ])
}

async function pauseRelay(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  await queryClient.cancelQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.relay.all[0] &&
      (queryKey[1] === queryKeys.relay.connection[1] ||
        queryKey[1] === queryKeys.relay.snapshot[1] ||
        queryKey[1] === relay.id),
  })
  const updatedRelay = await setRelayEnabled({
    data: { enabled: false, id: relay.id },
  })
  updateRelayCache(queryClient, [updatedRelay])
  await invalidateRelayRuntimeQueries(queryClient)
  dismissToast(relayResumedToastId(relay.id))
  showPausedRelayToast(queryClient, relay)
}

async function resumeRelay(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  const existing = pendingRelayResumes.get(relay.id)
  if (existing) return existing
  dismissToast(relayResumeErrorToastId(relay.id))
  const pending = performRelayResume(queryClient, relay)
  pendingRelayResumes.set(relay.id, pending)
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => pending,
      catch: (cause) => cause,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (pendingRelayResumes.get(relay.id) === pending)
            pendingRelayResumes.delete(relay.id)
        })
      )
    )
  )
}

async function performRelayResume(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  const updatedRelay = await setRelayEnabled({
    data: { enabled: true, id: relay.id },
  })
  updateRelayCache(queryClient, [updatedRelay])
  await invalidateRelayRuntimeQueries(queryClient)
  dismissToast(relayPausedToastId(relay.id))
  dismissToast(relayResumeErrorToastId(relay.id))
  showToast({
    type: "success",
    message: <RelayToastTitle name={relay.name} state="resumed" />,
    id: relayResumedToastId(relay.id),
    icon: <Play className="size-4 text-emerald-400 light:text-emerald-700" />,
    description: "Hearth has resumed requesting Relay data.",
    duration: 4_000,
  })
}

function showPausedRelayToast(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): void {
  showToast({
    type: "info",
    message: <RelayToastTitle name={relay.name} state="paused" />,
    id: relayPausedToastId(relay.id),
    icon: <Pause className="size-4 text-sky-400 light:text-sky-700" />,
    description: "Hearth stopped requesting data. The Relay remains online.",
    duration: Infinity,
    action: {
      label: "Reconnect",
      onClick: (event) => {
        event.preventDefault()
        forkPromise(
          () => resumeRelay(queryClient, relay),
          (cause) =>
            showToast({
              type: "error",
              message: (
                <RelayToastTitle
                  name={relay.name}
                  state="could not be resumed"
                />
              ),
              id: relayResumeErrorToastId(relay.id),
              description: messageFrom(cause, "Try reconnecting again."),
              duration: 6_000,
            })
        )
      },
    },
  })
}

export function showRelayError(cause: unknown, fallback: string) {
  showToast({
    type: "error",
    message: fallback,
    description: messageFrom(cause, fallback),
    duration: 6_000,
  })
}

function relayPausedToastId(relayId: string): string {
  return `relay-paused:${relayId}`
}

function relayResumedToastId(relayId: string): string {
  return `relay-resumed:${relayId}`
}

function relayResumeErrorToastId(relayId: string): string {
  return `relay-resume-error:${relayId}`
}

export function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
