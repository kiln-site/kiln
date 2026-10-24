import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Copy, TerminalSquare } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { useCopyFeedback } from "@/components/workspace-header"
import type { BackupRun } from "@/lib/backup-runs"
import type { KilnPlatformHost } from "@/server/platform"
import {
  kilnPlatformQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import {
  relayRouteIdentifier,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"
import {
  queueTerminalInput,
  relayTerminalInputKey,
} from "@/lib/terminal-prefill"

// Kiln restores with Hearth stopped, since Hearth can't replace its own
// database while serving from it. So the restore runs on the Relay's host:
// this shows the commands, and opens the Relay's terminal with them typed
// for the operator to send. See docs/self-hosting.md#recovery.

// The Relay that installed Kiln is the `kiln-relay` container; under Compose
// or Coolify, the operator knows its name.
function relayCli(managed: string | null) {
  return managed === "relay"
    ? "docker exec kiln-relay kiln-relay"
    : "docker exec <relay-container> kiln-relay"
}

export function KilnRestoreDialog({
  backup,
  onOpenChange,
  open,
}: {
  backup: BackupRun
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const relay = useRelayRoute(backup.relayId)
  const managed = useKilnManagedBy(backup.relayId)
  // The Relay keeps a local copy at a path of the backup's own ID.
  const local = backup.artifacts.some(
    (artifact) => artifact.storageId === null && artifact.status === "available"
  )
  const path = local ? `/data/backups/${backup.id}.zip` : "/data/restore.zip"
  const cli = relayCli(managed)
  const restore = `${cli} platform-backup restore ${path} --confirm ${backup.targetId}`
  const command =
    managed === "relay"
      ? `${cli} platform stop-hearth && ${restore} && ${cli} platform start-hearth`
      : restore
  const steps = [
    ...(local
      ? []
      : [
          <>
            This backup isn&apos;t on the Relay. Download it, then copy it into
            the Relay&apos;s container as{" "}
            <code className="font-mono text-foreground">/data/restore.zip</code>
            .
          </>,
        ]),
    managed === "relay" ? (
      <>
        Run this on the host. It holds Hearth stopped, restores, and starts
        Hearth again.
      </>
    ) : (
      <>
        Compose or Coolify runs Hearth: stop it there, run this on the host with
        the Relay&apos;s container name, then start Hearth again.
      </>
    ),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore Kiln</DialogTitle>
          <DialogDescription>
            This replaces Hearth&apos;s database with “{backup.name}”. Hearth
            stops while it restores, so it runs on {relay?.name ?? "the Relay"}
            &apos;s host. Everyone&apos;s pages reconnect once Hearth is back,
            usually within a minute; game servers, Apps, and databases keep
            running.
          </DialogDescription>
        </DialogHeader>
        {steps.length > 1 ? (
          <ol className="type-meta list-decimal space-y-1.5 pl-4 text-muted-foreground">
            {steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        ) : (
          <p className="type-meta text-muted-foreground">{steps[0]}</p>
        )}
        <CommandBlock command={command} />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {relay && managed === "relay" ? (
            <Button asChild type="button">
              <Link
                params={{ relayId: relay.routeId }}
                to="/relay/$relayId/terminal"
                onClick={() =>
                  queueTerminalInput(
                    relayTerminalInputKey(backup.relayId),
                    command
                  )
                }
              >
                <TerminalSquare />
                Open in terminal
              </Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CommandBlock({ command }: { command: string }) {
  const { copied, copy } = useCopyFeedback(command)
  return (
    <div className="flex items-start gap-2 border border-border/70 bg-background/35 p-3">
      <code className="min-w-0 flex-1 font-mono text-xs leading-5 break-all">
        {command}
      </code>
      <Button
        aria-label="Copy the restore command"
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

function useRelayRoute(relayId: string) {
  const select = React.useCallback(
    (relays: Array<RelayDirectoryEntry>) => {
      const relay = relays.find((candidate) => candidate.id === relayId)
      return relay
        ? { name: relay.name, routeId: relayRouteIdentifier(relays, relay) }
        : null
    },
    [relayId]
  )
  return useQuery({ ...relaysQueryOptions(), select }).data ?? null
}

// Who runs Kiln on that Relay's host: the Relay itself, or Compose/Coolify.
function useKilnManagedBy(relayId: string) {
  const select = React.useCallback(
    (data: { hosts: ReadonlyArray<KilnPlatformHost> }) =>
      data.hosts.find((host) => host.relayId === relayId)?.status?.management ??
      null,
    [relayId]
  )
  return (
    useQuery({
      ...kilnPlatformQueryOptions(),
      refetchInterval: false,
      select,
    }).data ?? null
  )
}
