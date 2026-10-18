import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RelayHostFiles } from "@workspace/contracts"
import {
  HardDrive,
  LoaderCircle,
  RadioTower,
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
import { showToast } from "@workspace/ui/components/sonner"

import { FilePageContent } from "@/components/files/file-page-content"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { getRelayHostAccess, mountRelayHostFiles } from "@/server/relay-host"

const hostAccessKey = (relayId: string) => ["relay-host-access", relayId]

// Whether the Relay allows host access, and the state of its host files.
export function relayHostAccessQueryOptions(relayId: string) {
  return {
    queryKey: hostAccessKey(relayId),
    queryFn: () => getRelayHostAccess({ data: { relayId } }),
    retry: false,
    staleTime: 30_000,
  }
}

function useRelayHostAccess() {
  const { relay } = useRelayWorkspace()
  const { connected, relayStatus } = useRelayLiveStatus(relay)
  const access = useQuery({
    ...relayHostAccessQueryOptions(relay.id),
    enabled: connected,
    // While the Relay restarts to mount host files, check until it's back.
    staleTime: (query) =>
      query.state.data?.files.status === "mounting" ? 0 : 30_000,
    refetchInterval: (query) =>
      query.state.data?.files.status === "mounting" ? 2_000 : false,
  })
  return { access, connected, relayId: relay.id, relayStatus }
}

export function RelayHostTerminalAccess({
  children,
}: {
  children: React.ReactNode
}) {
  const { access, connected } = useRelayHostAccess()
  if (!connected) return <WaitingForRelay />
  if (access.isPending) return <div className="min-h-0 flex-1 bg-card" />
  if (access.data?.terminal) return children
  return (
    <HostUnavailable
      icon={<RadioTower />}
      title="Host terminal unavailable"
      description={
        access.error?.message ??
        "Enable host access in the Relay's configuration to open a shell on this node."
      }
    />
  )
}

export function RelayHostFilesAccess({
  children,
}: {
  children: (limitation: RelayHostFiles["limitation"]) => React.ReactNode
}) {
  const { access, connected, relayId, relayStatus } = useRelayHostAccess()
  const files = access.data?.files
  // Still mounting while the Relay is away restarting.
  if (files?.status === "mounting") {
    return (
      <>
        <FilePageContent view="waiting" />
        <HostUnavailable
          icon={<LoaderCircle className="animate-spin" />}
          title="Mounting host files"
          description="The Relay is restarting with its host's filesystem mounted. Servers keep running, and this page opens when the Relay is back."
        />
      </>
    )
  }
  if (!connected) {
    return (
      <>
        {/* Not while Hearth is still checking whether the Relay is there. */}
        <FilePageContent reached={relayStatus !== "checking"} view="waiting" />
        <WaitingForRelay />
      </>
    )
  }
  if (access.isPending) return <div className="min-h-0 flex-1 bg-card" />
  if (!files) {
    return (
      <>
        <FilePageContent view="unavailable" />
        <HostUnavailable
          icon={<RadioTower />}
          title="Host filesystem unavailable"
          description={access.error?.message ?? "Update this Relay."}
        />
      </>
    )
  }
  switch (files.status) {
    case "ready":
      return children(files.limitation)
    case "disabled":
      return (
        <>
          <FilePageContent view="unavailable" />
          <HostUnavailable
            icon={<RadioTower />}
            title="Host access is off"
            description="Set KILN_RELAY_HOST_ACCESS=true on the Relay to browse its host's files."
          />
        </>
      )
    case "unmounted":
      return (
        <>
          <FilePageContent view="unavailable" />
          <MountHostFiles relayId={relayId} mountError={files.mountError} />
        </>
      )
  }
}

function MountHostFiles({
  mountError,
  relayId,
}: {
  mountError: string | null
  relayId: string
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)
  const { data: canMount = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relayId, "relay.files.mount"),
  })
  const mount = useMutation({
    mutationFn: () => mountRelayHostFiles({ data: { relayId } }),
    onSuccess: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: hostAccessKey(relayId) })
    },
    onError: (cause) =>
      showToast({
        type: "error",
        message: "Could not mount host files",
        description: cause.message,
      }),
  })
  return (
    <HostUnavailable
      icon={<HardDrive />}
      title="Host files aren't mounted"
      description="The Relay needs its host's filesystem mounted to browse it."
    >
      {mountError ? (
        <p className="mt-3 text-xs leading-relaxed text-destructive">
          The last attempt didn't work, so the Relay was put back as it was:{" "}
          {mountError}
        </p>
      ) : null}
      {canMount ? (
        <Button className="mt-4" size="sm" onClick={() => setConfirming(true)}>
          <HardDrive />
          Mount host files
        </Button>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Someone who can mount host files on this Relay can turn it on.
        </p>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Or start the Relay with{" "}
        <code className="font-mono">compose.host-files.yaml</code>.
      </p>
      {confirming ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!mount.isPending) setConfirming(open)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Mount host files?</DialogTitle>
              <DialogDescription>
                The Relay restarts with its host&apos;s filesystem mounted, and
                is offline for a few seconds. Servers keep running. Anyone who
                can edit host files can then change any file on this host.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                disabled={mount.isPending}
                type="button"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={mount.isPending}
                type="button"
                onClick={() => mount.mutate()}
              >
                {mount.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <HardDrive />
                )}
                Mount and restart
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </HostUnavailable>
  )
}

const limitationMessages: Record<
  NonNullable<RelayHostFiles["limitation"]>,
  string
> = {
  rootless:
    "Docker runs rootless on this host, so the Relay can only open and change files its Docker user can.",
  "user-namespace":
    "Docker remaps container users on this host, so the Relay can only open and change files its remapped user can.",
  "non-root":
    "The Relay isn't running as root, so it can only open and change files its user can.",
  selinux:
    "SELinux confines the Relay, so it can't open most host files. Add security_opt: [label=disable] to the Relay's service to lift it.",
  "read-only":
    "The host's filesystem is mounted read-only, so files can't be changed.",
}

export function HostFilesLimitation({
  limitation,
}: {
  limitation: NonNullable<RelayHostFiles["limitation"]>
}) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/35 bg-amber-500/10 px-4 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      {limitationMessages[limitation]}
    </div>
  )
}

function WaitingForRelay() {
  return (
    <HostUnavailable
      icon={<RadioTower />}
      title="Waiting for the Relay"
      description="This page will open when the Relay reconnects."
    />
  )
}

function HostUnavailable({
  children,
  description,
  icon,
  title,
}: {
  children?: React.ReactNode
  description: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="flex max-w-sm flex-col items-center">
        <span className="mb-4 text-muted-foreground [&_svg]:size-5">
          {icon}
        </span>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
        {children}
      </div>
    </div>
  )
}
