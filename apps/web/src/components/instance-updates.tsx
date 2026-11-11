import * as React from "react"
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { LoaderCircle, RefreshCw } from "lucide-react"

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
import { cn } from "@workspace/ui/lib/utils"

import { shortDigest } from "@/components/app/app-deployment-presentation"
import { Field } from "@/components/github-sync-dialogs"
import { RelativeTime } from "@/components/relative-time"
import type {
  InstanceUpdateKind,
  InstanceUpdateMode,
} from "@/effect/instance-updates"
import { queryKeys } from "@/lib/query-options"
import {
  checkInstanceUpdate,
  deployInstanceUpdate,
  getInstanceUpdates,
  saveInstanceUpdatePolicy,
  skipInstanceUpdate,
} from "@/server/instance-updates"

// Whether an instance's image tag names a newer image than the one it
// runs, and what Kiln does about it: the Updates row every kind's Info page
// has, and the dialog it opens.

export type InstanceUpdates = NonNullable<
  Awaited<ReturnType<typeof getInstanceUpdates>>
>

/** The instance an Updates row is for, and what this person may do. */
export interface UpdatedInstance {
  /** Whoever may deploy it decides when it deploys. */
  canDeploy: boolean
  /** Opens where its deployment can be followed, for whoever can. */
  followDeployment?: (() => Promise<void>) | undefined
  id: string
  kind: InstanceUpdateKind
  relayId: string
}

// What taking an update does to each kind while it happens.
const updateCost: Record<InstanceUpdateKind, string | null> = {
  app: null,
  database:
    "Updating replaces its container over the same data. It is away while the new one starts.",
  server: "Updating replaces its container, which restarts the server.",
}

const failed = (message: string) => (error: unknown) =>
  showToast({
    description: error instanceof Error ? error.message : undefined,
    message,
    type: "error",
  })

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const modes = [
  ["notify", "Notify", "Tell everyone who can deploy it"],
  ["auto", "Automatic", "Deploy updates once they've waited"],
  ["off", "Off", "Don't check for updates"],
] as const satisfies ReadonlyArray<
  readonly [InstanceUpdateMode, string, string]
>

// The row's one-line answer, and whether it asks for attention.
function updateStatus(updates: InstanceUpdates): {
  label: string
  tone: "attention" | "muted" | "plain" | "problem"
} {
  if (updates.pinned) return { label: "Pinned to a digest", tone: "muted" }
  if (updates.mode === "off") return { label: "Off", tone: "muted" }
  if (updates.state === "available") {
    if (updates.latestDigest === updates.skippedDigest) {
      return { label: "Skipped", tone: "muted" }
    }
    if (updates.autoUpdateAt !== null) {
      return {
        label: `Deploys ${dateFormatter.format(updates.autoUpdateAt)}`,
        tone: "attention",
      }
    }
    // An automatic update waits for a check that gets through.
    return updates.mode === "auto" && updates.checkError
      ? { label: "Check failed", tone: "problem" }
      : { label: "Update available", tone: "attention" }
  }
  if (updates.checkError) return { label: "Check failed", tone: "problem" }
  switch (updates.state) {
    case "current":
      return { label: "Up to date", tone: "plain" }
    case "changed":
      return { label: "Deploy to apply", tone: "muted" }
    case "untracked":
      return { label: "Deploy to track", tone: "muted" }
    case "not_deployed":
      return { label: "Not deployed", tone: "muted" }
    case null:
      return { label: "Not checked yet", tone: "muted" }
  }
}

/** What an Updates row says, which opens the dialog. */
export const InstanceUpdatesStatus = React.memo(function InstanceUpdatesStatus({
  instance,
  updates,
}: {
  instance: UpdatedInstance
  updates: InstanceUpdates
}) {
  const [open, setOpen] = React.useState(false)
  const status = updateStatus(updates)
  return (
    <>
      {updates.pinned ? (
        <span className="text-muted-foreground">{status.label}</span>
      ) : (
        <button
          type="button"
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-sm outline-none hover:text-primary-ink focus-visible:ring-1 focus-visible:ring-ring",
            status.tone === "muted" && "text-muted-foreground",
            status.tone === "attention" && "text-primary-ink",
            status.tone === "problem" && "text-destructive"
          )}
          title={updates.checkError ?? undefined}
          onClick={() => setOpen(true)}
        >
          {status.tone === "attention" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          <span className="truncate">{status.label}</span>
        </button>
      )}
      {open ? (
        <InstanceUpdatesDialog
          instance={instance}
          updates={updates}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
})

/** A game server's or a database's updates, as its page asks for them. */
export function instanceUpdatesQueryOptions(
  instance: Pick<UpdatedInstance, "id" | "kind" | "relayId">
) {
  return queryOptions({
    queryKey: queryKeys.appDeployments.updates(instance.relayId, instance.id),
    queryFn: () =>
      getInstanceUpdates({
        data: {
          instanceId: instance.id,
          kind: instance.kind,
          relayId: instance.relayId,
        },
      }),
    staleTime: 30_000,
  })
}

function InstanceUpdatesDialog({
  instance,
  onOpenChange,
  updates,
}: {
  instance: UpdatedInstance
  onOpenChange: (open: boolean) => void
  updates: InstanceUpdates
}) {
  const queryClient = useQueryClient()
  // Whoever may deploy it decides when it deploys, and may skip an update.
  const canManage = instance.canDeploy
  const canDeploy = instance.canDeploy
  const cost = updateCost[instance.kind]
  const input = {
    instanceId: instance.id,
    kind: instance.kind,
    relayId: instance.relayId,
  }
  const [mode, setMode] = React.useState<InstanceUpdateMode>(updates.mode)
  const [waitDays, setWaitDays] = React.useState(() =>
    String(Math.round((updates.delayHours / 24) * 10) / 10)
  )
  const delayHours = Math.round(Number(waitDays) * 24)
  const waitValid =
    waitDays.trim() !== "" &&
    Number.isFinite(delayHours) &&
    delayHours >= 0 &&
    delayHours <= 2_160
  const policyChanged =
    mode !== updates.mode ||
    (mode === "auto" && delayHours !== updates.delayHours)
  // An App's updates come with its summary; another kind's on their own.
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey:
        instance.kind === "app"
          ? queryKeys.appDeployments.summary(instance.relayId, instance.id)
          : queryKeys.appDeployments.updates(instance.relayId, instance.id),
    })

  const check = useMutation({
    mutationFn: () => checkInstanceUpdate({ data: input }),
    onSuccess: refresh,
    onError: failed("Could not check"),
  })
  const save = useMutation({
    mutationFn: () =>
      saveInstanceUpdatePolicy({
        data: {
          ...input,
          delayHours: mode === "auto" ? delayHours : updates.delayHours,
          mode,
        },
      }),
    onSuccess: async () => {
      await refresh()
      showToast({ message: "Saved", type: "success" })
    },
    onError: failed("Could not save"),
  })
  const skip = useMutation({
    mutationFn: (digest: string) =>
      skipInstanceUpdate({ data: { ...input, digest } }),
    onSuccess: refresh,
    onError: failed("Could not skip"),
  })
  const deploy = useMutation({
    mutationFn: () => deployInstanceUpdate({ data: input }),
    onSuccess: async () => {
      // It runs once anything else on the instance ends.
      showToast({ message: "Update queued", type: "success" })
      await refresh()
      onOpenChange(false)
      // Follow the deployment as it happens.
      await instance.followDeployment?.()
    },
    onError: failed("Could not update"),
  })
  const busy =
    check.isPending || save.isPending || skip.isPending || deploy.isPending
  const available = updates.state === "available" ? updates.latestDigest : null
  const skipped = available !== null && available === updates.skippedDigest

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Image updates</DialogTitle>
          <DialogDescription>
            Kiln checks{" "}
            {updates.image ? (
              <span className="font-mono text-foreground">{updates.image}</span>
            ) : (
              "its image"
            )}{" "}
            every hour for a newer one.
          </DialogDescription>
        </DialogHeader>

        <dl className="divide-y divide-border/60 border-y border-border/60 text-[0.8125rem]">
          <DialogFact label="Running">
            {updates.runningDigest ? (
              <span className="font-mono text-xs">
                {shortDigest(updates.runningDigest)}
              </span>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </DialogFact>
          {available ? (
            <DialogFact label="Available">
              <span className="font-mono text-xs">
                {shortDigest(available)}
              </span>
              {updates.latestSeenAt !== null ? (
                <span className="text-muted-foreground">
                  · seen <RelativeTime timestamp={updates.latestSeenAt} />
                </span>
              ) : null}
            </DialogFact>
          ) : null}
          {updates.autoUpdateAt !== null ? (
            <DialogFact label="Deploys">
              {dateFormatter.format(updates.autoUpdateAt)}
            </DialogFact>
          ) : null}
          <DialogFact label="Checked">
            {updates.checkedAt !== null ? (
              <RelativeTime timestamp={updates.checkedAt} />
            ) : (
              <span className="text-muted-foreground">Not yet</span>
            )}
            {canManage ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy || updates.mode === "off"}
                onClick={() => check.mutate()}
              >
                {check.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Check now
              </Button>
            ) : null}
          </DialogFact>
          {updates.checkError ? (
            <p role="alert" className="py-2 text-xs text-destructive">
              {updates.checkError}
            </p>
          ) : null}
        </dl>

        {available && (canManage || canDeploy) ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {skipped
                ? "Skipped; it won't deploy on its own."
                : "A newer image is out."}
              {cost ? ` ${cost}` : null}
            </p>
            <div className="flex shrink-0 gap-2">
              {skipped || !canManage ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => skip.mutate(available)}
                >
                  Skip
                </Button>
              )}
              {canDeploy ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => deploy.mutate()}
                >
                  {deploy.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Update now
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div
          role="radiogroup"
          aria-label="When the image updates"
          className="grid grid-cols-3 gap-2"
        >
          {modes.map(([value, label, detail]) => (
            <button
              key={value}
              role="radio"
              aria-checked={mode === value}
              type="button"
              disabled={!canManage}
              className={cn(
                "flex flex-col gap-0.5 border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                mode === value
                  ? "border-primary/60 bg-primary/10"
                  : "hover:bg-muted/40"
              )}
              onClick={() => setMode(value)}
            >
              <span className="text-[0.8125rem] font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{detail}</span>
            </button>
          ))}
        </div>
        {mode === "auto" ? (
          <Field label="Wait" hint="Days an update is out before it deploys">
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={90}
              step={0.5}
              disabled={!canManage}
              value={waitDays}
              onChange={(event) => setWaitDays(event.currentTarget.value)}
            />
          </Field>
        ) : null}

        {canManage ? (
          <DialogFooter>
            <Button
              disabled={
                busy || !policyChanged || (mode === "auto" && !waitValid)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DialogFact({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-9 items-center gap-3 py-1">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {children}
      </dd>
    </div>
  )
}
