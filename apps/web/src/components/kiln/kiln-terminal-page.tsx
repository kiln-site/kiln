import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { TerminalSquare } from "lucide-react"
import type { RelayPlatformTarget } from "@workspace/contracts"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import {
  kilnContainers,
  kilnCopy,
  kilnShellAvailable,
  useKilnHost,
} from "@/components/kiln/kiln-presentation"
import type { TerminalBackend } from "@/components/terminal-session"
import { platformTerminalStreamUrl } from "@/lib/database-terminal-stream"
import type { KilnPlatformHost } from "@/server/platform"
import {
  claimKilnTerminal,
  restartKilnTerminal,
  writeKilnTerminal,
} from "@/server/platform"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

// A shell in one of Kiln's containers that has one: its database, cache, or
// the Traefik Kiln runs. Hearth's image has none.
export function KilnTerminalPage() {
  const host = useKilnHost()
  const navigate = useNavigate()
  const requested = useSearch({
    from: "/_app/kiln/terminal",
    select: (search) => search.service,
  })
  const targets = React.useMemo(
    () =>
      host?.status
        ? kilnContainers(host.status)
            .filter((container) => kilnShellAvailable(host, container))
            .map((container) => container.target)
        : [],
    [host]
  )
  const target = targets.find((option) => option === requested) ?? targets[0]
  const select = React.useCallback(
    (next: string) =>
      void navigate({
        replace: true,
        search: { service: next as RelayPlatformTarget },
        to: "/kiln/terminal",
      }),
    [navigate]
  )
  if (!host || !target) return <KilnTerminalUnavailable host={host} />
  const picker =
    targets.length > 1 ? (
      <Select value={target} onValueChange={select}>
        <SelectTrigger
          aria-label="Container"
          className="h-8 w-auto min-w-36 px-3 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {targets.map((option) => (
            <SelectItem key={option} value={option}>
              {kilnCopy[option].title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <KilnTerminalSession
        key={`${host.relayId}:${target}`}
        relayId={host.relayId}
        target={target}
        toolbarActions={picker}
      />
    </React.Suspense>
  )
}

function KilnTerminalUnavailable({ host }: { host: KilnPlatformHost | null }) {
  const status = host?.status
  const message = !host
    ? { title: "No Relay reports Kiln", detail: "" }
    : !host.v2
      ? {
          title: "Update this Relay",
          detail: `Update ${host.relayName} to open shells in Kiln's containers.`,
        }
      : status?.management === "external"
        ? {
            title: "Kiln only shows these containers",
            detail:
              "Compose or Coolify manages them, so open a shell where they were deployed.",
          }
        : !status?.canManage
          ? {
              title: "Only the Hearth this Relay installed",
              detail:
                "Shells open only from the Hearth that the Relay installed.",
            }
          : {
              title: "No container to open a shell in",
              detail:
                "Hearth's image has no shell, and the others aren't running.",
            }
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          <TerminalSquare className="size-5" />
        </div>
        <p className="text-sm font-semibold">{message.title}</p>
        {message.detail ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {message.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function KilnTerminalSession({
  relayId,
  target,
  toolbarActions,
}: {
  relayId: string
  target: RelayPlatformTarget
  toolbarActions: React.ReactNode
}) {
  const backend = React.useMemo<TerminalBackend>(() => {
    const input = { relayId, role: target }
    return {
      claim: (claim) => claimKilnTerminal({ data: { ...input, ...claim } }),
      noun: kilnCopy[target].noun,
      startFailure: {
        title: "Couldn't start a shell",
        detail: "This container's image may have no shell (sh).",
      },
      restart: () => restartKilnTerminal({ data: input }),
      streamUrl: (size) => platformTerminalStreamUrl({ ...input, ...size }),
      write: (sessionId, data) =>
        writeKilnTerminal({ data: { ...input, data, sessionId } }),
    }
  }, [relayId, target])
  return <TerminalSession backend={backend} toolbarActions={toolbarActions} />
}
