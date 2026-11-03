import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { HardDrive, Images, Layers } from "lucide-react"
import type { RelayDockerStorage } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import { InfoFact, InfoHint, InfoSection } from "@/components/info-page"
import { messageFrom } from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { RelativeTime } from "@/components/relative-time"
import { formatBytes } from "@/lib/format-bytes"
import { queryKeys, relayDockerStorageQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import { cleanUpRelayDocker } from "@/server/relay-docker"

// What Docker holds on the Relay's host, what Kiln's cleanup could remove
// of it, and a cleanup now for someone who may configure the Relay.
export function RelayDockerStorageSection({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  const { connected } = useRelayLiveStatus(relay)
  const canClean = useRelayPermission(relay.id, "relay.configure")
  const [choosing, setChoosing] = React.useState(false)
  const { data: storage, error } = useQuery({
    ...relayDockerStorageQueryOptions(relay.id),
    enabled: connected,
  })
  useCleanupFinishedToast(relay, storage)
  const running = storage?.cleaning ?? null
  const action =
    canClean && storage && connected ? (
      <Button
        disabled={running !== null}
        size="sm"
        variant="outline"
        onClick={() => setChoosing(true)}
      >
        {running ? "Cleaning up…" : "Clean up"}
      </Button>
    ) : null

  if (!storage || !connected) {
    return (
      <InfoSection icon={<HardDrive />} title="Docker storage">
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {!relay.enabled
            ? "Resume this Relay to see its Docker storage."
            : !connected
              ? "Docker storage appears once Hearth reaches the Relay."
              : error
                ? messageFrom(error, "Could not read Docker storage.")
                : "Measuring Docker storage…"}
        </p>
      </InfoSection>
    )
  }

  return (
    <InfoSection icon={<HardDrive />} title="Docker storage" action={action}>
      <InfoFact label="Images">
        {storage.images.count} · {formatBytes(storage.images.bytes)}
      </InfoFact>
      <InfoFact label="Kiln can remove">
        {amount(storage.reclaimable)}
        <InfoHint label="What Kiln removes" title="What Kiln removes">
          <p>
            The Relay removes images no Kiln container has used for a day, App
            images older than each App’s 5 newest deployments, and old Hearth
            and Relay images but the one before the latest update. It checks
            every hour. Cleaning up now removes them without waiting the day.
          </p>
        </InfoHint>
      </InfoFact>
      <InfoFact label="Other unused images">
        {amount(storage.unknown)}
        <InfoHint
          label="About images Kiln didn’t run"
          title="Images Kiln didn’t run"
        >
          <p>
            Images no Kiln container has used since the Relay began keeping
            track, such as ones pulled by hand or left from before. Kiln removes
            them only when you ask.
          </p>
        </InfoHint>
      </InfoFact>
      <InfoFact label="Build cache">
        {formatBytes(storage.buildCache.bytes)}
        {storage.buildCache.reclaimableBytes > 0
          ? ` · ${formatBytes(storage.buildCache.reclaimableBytes)} unused`
          : null}
      </InfoFact>
      {storage.leftoverContainers > 0 ? (
        <InfoFact label="Leftover containers">
          {storage.leftoverContainers} waiting to be removed
        </InfoFact>
      ) : null}
      <InfoFact label={running ? "Cleanup" : "Last cleanup"}>
        {running ? (
          <span className="truncate">
            Running, started <RelativeTime timestamp={running.startedAt} />
          </span>
        ) : (
          <LastCleanup cleanup={storage.lastCleanup} />
        )}
      </InfoFact>
      {choosing ? (
        <CleanUpDialog
          relay={relay}
          storage={storage}
          onOpenChange={setChoosing}
        />
      ) : null}
    </InfoSection>
  )
}

// Says how a cleanup this page saw running ended, once it's done. One that
// ends after someone leaves the page shows as the card's last cleanup.
function useCleanupFinishedToast(
  relay: RelayDirectoryEntry,
  storage: RelayDockerStorage | undefined
) {
  const watching = React.useRef<number | null>(null)
  const startedAt = storage?.cleaning?.startedAt ?? null
  const finished = storage?.lastCleanup ?? null
  React.useEffect(() => {
    if (startedAt !== null) {
      watching.current = startedAt
      return
    }
    const since = watching.current
    if (since === null || !finished || finished.finishedAt < since) return
    watching.current = null
    showToast(
      finished.error
        ? {
            description: finished.error,
            message: `${relay.name} didn’t finish cleaning up`,
            type: "error",
          }
        : {
            description: capitalized(`${cleanupSummary(finished)}.`),
            message: `Cleaned up ${relay.name}`,
            type: "success",
          }
    )
  }, [finished, relay.name, startedAt])
}

function capitalized(text: string) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function amount({ bytes, images }: { bytes: number; images: number }) {
  return images === 0
    ? "Nothing"
    : `${images} ${images === 1 ? "image" : "images"} · ${formatBytes(bytes)}`
}

function LastCleanup({
  cleanup,
}: {
  cleanup: RelayDockerStorage["lastCleanup"]
}) {
  if (!cleanup) return <>Not since the Relay started</>
  if (cleanup.error) {
    return (
      <span className="truncate" title={cleanup.error}>
        <RelativeTime timestamp={cleanup.finishedAt} /> · didn’t finish
      </span>
    )
  }
  return (
    <span className="truncate">
      <RelativeTime timestamp={cleanup.finishedAt} /> ·{" "}
      {cleanupSummary(cleanup)}
    </span>
  )
}

// "freed 1.2 GiB, 3 containers", or that there was nothing to remove.
function cleanupSummary({
  buildCacheBytes,
  containers,
  imageBytes,
  images,
}: {
  buildCacheBytes: number
  containers: number
  imageBytes: number
  images: number
}) {
  const parts = [
    ...(images > 0 || buildCacheBytes > 0
      ? [`freed ${formatBytes(imageBytes + buildCacheBytes)}`]
      : []),
    ...(containers > 0
      ? [`${containers} ${containers === 1 ? "container" : "containers"}`]
      : []),
  ]
  return parts.length > 0 ? parts.join(", ") : "nothing to remove"
}

function CleanUpDialog({
  onOpenChange,
  relay,
  storage,
}: {
  onOpenChange: (open: boolean) => void
  relay: RelayDirectoryEntry
  storage: RelayDockerStorage
}) {
  const queryClient = useQueryClient()
  const [buildCache, setBuildCache] = React.useState(false)
  const [unknownImages, setUnknownImages] = React.useState(false)
  // Only starting it waits: the cleanup itself runs on the Relay in the
  // background, and the card shows it until it's done.
  const cleanup = useMutation({
    mutationFn: () =>
      cleanUpRelayDocker({
        data: { buildCache, relayId: relay.id, unknownImages },
      }),
    onSuccess: async (started) => {
      onOpenChange(false)
      // A read from before it started mustn't land after and hide it.
      await queryClient.cancelQueries({
        queryKey: queryKeys.relayDockerStorage(relay.id),
      })
      queryClient.setQueryData<RelayDockerStorage>(
        queryKeys.relayDockerStorage(relay.id),
        (current) =>
          current && {
            ...current,
            cleaning: { startedAt: started.startedAt },
          }
      )
      showToast({
        description: started.alreadyRunning
          ? "The current cleanup will continue."
          : "It runs in the background; you can leave this page.",
        message: started.alreadyRunning
          ? `${relay.name} is already cleaning up`
          : `Cleaning up ${relay.name}`,
        type: "info",
      })
    },
    onError: (cause) =>
      showToast({
        description: messageFrom(cause, "The Relay didn’t start cleaning up."),
        message: "Could not clean up Docker",
        type: "error",
      }),
  })
  const pending = cleanup.isPending

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clean up {relay.name}’s Docker?</DialogTitle>
          <DialogDescription>
            {storage.reclaimable.images > 0
              ? `Removes ${amount(storage.reclaimable)} Kiln no longer needs, and any leftover containers.`
              : "Kiln has no images of its own to remove right now; any leftover containers are removed."}{" "}
            Volumes and their data are never removed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <CleanUpOption
            checked={unknownImages}
            disabled={pending}
            icon={<Images />}
            title={`Also remove other unused images (${formatBytes(storage.unknown.bytes)})`}
            onChange={setUnknownImages}
          >
            Images no container uses that Kiln didn’t run, including ones pulled
            by hand on this host. They’re downloaded again if needed.
          </CleanUpOption>
          <CleanUpOption
            checked={buildCache}
            disabled={pending}
            icon={<Layers />}
            title={`Also clear unused build cache (${formatBytes(storage.buildCache.reclaimableBytes)})`}
            onChange={setBuildCache}
          >
            Docker’s build cache is shared with every build on this host, so the
            next App build, and yours, start from scratch.
          </CleanUpOption>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending}
            type="button"
            onClick={() => cleanup.mutate()}
          >
            {pending ? "Starting…" : "Clean up"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CleanUpOption({
  checked,
  children,
  disabled,
  icon,
  onChange,
  title,
}: {
  checked: boolean
  children: React.ReactNode
  disabled: boolean
  icon: React.ReactNode
  onChange: (checked: boolean) => void
  title: string
}) {
  const id = React.useId()
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background/35 p-3 transition-colors hover:bg-muted/25 has-checked:border-primary/35 has-checked:bg-primary/[0.06]">
      <input
        aria-describedby={id}
        checked={checked}
        className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span
          id={id}
          className="mt-0.5 block text-xs leading-5 text-muted-foreground"
        >
          {children}
        </span>
      </span>
    </label>
  )
}
