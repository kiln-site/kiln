import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
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
import {
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { Field } from "@/components/github-sync-dialogs"
import { InfoFact } from "@/components/info-page"
import { RelativeTime } from "@/components/relative-time"
import type { AppImageUpdateMode } from "@/effect/app-image-updates"
import { queryKeys } from "@/lib/query-options"
import type { getAppDeploymentSummary } from "@/server/app-deployments"
import {
  checkAppImageUpdate,
  deployAppImageUpdate,
  saveAppImageUpdatePolicy,
  skipAppImageUpdate,
} from "@/server/app-image-updates"

// Whether an image app's tag names a newer image than the one it runs, and
// what Kiln does about it: the Deployment card's Updates row, and the
// dialog it opens.

export type AppImageUpdates = NonNullable<
  Awaited<ReturnType<typeof getAppDeploymentSummary>>["imageUpdates"]
>

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const modes = [
  ["notify", "Notify", "Tell everyone who can deploy it"],
  ["auto", "Automatic", "Deploy updates once they've waited"],
  ["off", "Off", "Don't check for updates"],
] as const satisfies ReadonlyArray<
  readonly [AppImageUpdateMode, string, string]
>

// The row's one-line answer, and whether it asks for attention.
function updateStatus(updates: AppImageUpdates): {
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

/** The Deployment card's Updates row, which opens the dialog. */
export const AppImageUpdatesFact = React.memo(function AppImageUpdatesFact({
  app,
  routeId,
  updates,
}: {
  app: Pick<App, "id" | "name" | "permissions" | "relayId">
  routeId: string
  updates: AppImageUpdates
}) {
  const [open, setOpen] = React.useState(false)
  const status = updateStatus(updates)
  return (
    <InfoFact label="Updates">
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
        <AppImageUpdatesDialog
          app={app}
          routeId={routeId}
          updates={updates}
          onOpenChange={setOpen}
        />
      ) : null}
    </InfoFact>
  )
})

function AppImageUpdatesDialog({
  app,
  onOpenChange,
  routeId,
  updates,
}: {
  app: Pick<App, "id" | "name" | "permissions" | "relayId">
  onOpenChange: (open: boolean) => void
  routeId: string
  updates: AppImageUpdates
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canManage = app.permissions.includes("app.manage")
  const input = { appId: app.id, relayId: app.relayId }
  const [mode, setMode] = React.useState<AppImageUpdateMode>(updates.mode)
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
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.appDeployments.summary(app.relayId, app.id),
    })

  const check = useMutation({
    mutationFn: () => checkAppImageUpdate({ data: input }),
    onSuccess: refresh,
    onError: (error) => showAppOperationError("Could not check", error),
  })
  const save = useMutation({
    mutationFn: () =>
      saveAppImageUpdatePolicy({
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
    onError: (error) => showAppOperationError("Could not save", error),
  })
  const skip = useMutation({
    mutationFn: (digest: string) =>
      skipAppImageUpdate({ data: { ...input, digest } }),
    onSuccess: refresh,
    onError: (error) => showAppOperationError("Could not skip", error),
  })
  const deploy = useMutation({
    mutationFn: () => deployAppImageUpdate({ data: input }),
    onSuccess: async () => {
      await refresh()
      onOpenChange(false)
      // Follow the deployment as it happens.
      if (app.permissions.includes("app.logs.read")) {
        await navigate({
          params: { appId: routeId },
          search: { stream: "deployment" },
          to: "/app/$appId/logs",
        })
        return
      }
      showToast({ message: "Deploying the update", type: "success" })
    },
    onError: (error) => showAppOperationError("Could not deploy", error),
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
            <span className="font-mono text-foreground">{updates.image}</span>{" "}
            every hour for a newer image.
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

        {available && canManage ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {skipped
                ? "Skipped; it won't deploy on its own."
                : "A newer image is out."}
            </p>
            <div className="flex shrink-0 gap-2">
              {skipped ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => skip.mutate(available)}
                >
                  Skip
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => deploy.mutate()}>
                {deploy.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                Update now
              </Button>
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
