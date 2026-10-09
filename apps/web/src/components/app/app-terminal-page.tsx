import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Play } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import { appServices } from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import type { TerminalBackend } from "@/components/terminal-session"
import { appTerminalStreamUrl } from "@/lib/database-terminal-stream"
import {
  claimAppTerminal,
  restartAppTerminal,
  writeAppTerminal,
} from "@/server/apps"

const TerminalSession = React.lazy(async () => {
  const module = await import("@/components/terminal-session")
  return { default: module.TerminalSession }
})

// A full shell in one of the app's services, kept on the Relay like a
// database's terminal.
export function AppTerminalPage() {
  const { app, routeId } = useAppWorkspace()
  const navigate = useNavigate()
  const requested = useSearch({
    from: "/_app/app/$appId/terminal",
    select: (search) => search.service,
  })
  const services = appServices(app)
  const service =
    requested && services.includes(requested) ? requested : services[0]
  const running = app.containers.some(
    (container) => container.service === service && container.running
  )
  const selectService = React.useCallback(
    (next: string) =>
      void navigate({
        params: { appId: routeId },
        replace: true,
        search: { service: next },
        to: "/app/$appId/terminal",
      }),
    [navigate, routeId]
  )
  const serviceSelect =
    services.length > 1 && service ? (
      <Select value={service} onValueChange={selectService}>
        <SelectTrigger
          aria-label="Service"
          className="h-8 w-auto min-w-36 px-3 font-mono text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {services.map((name) => (
            <SelectItem key={name} value={name} className="font-mono">
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null

  // Unavailable inventory only has a placeholder state; the terminal shows
  // its own reconnecting state while the Relay is away.
  if (!service || (app.inventoryStatus !== "unavailable" && !running)) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
            <Play className="size-5" />
          </div>
          <p className="text-sm font-semibold">
            {service
              ? `${service} is not running`
              : `${app.name} is not deployed`}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {service
              ? "Start the app to open a shell in it."
              : "Deploy the app to open a shell in its containers."}
          </p>
          {serviceSelect ? (
            <div className="mt-4 flex justify-center">{serviceSelect}</div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <AppTerminalSession
        key={`${app.relayId}:${app.id}:${service}`}
        appId={app.id}
        relayId={app.relayId}
        service={service}
        toolbarActions={serviceSelect}
      />
    </React.Suspense>
  )
}

function AppTerminalSession({
  appId,
  relayId,
  service,
  toolbarActions,
}: {
  appId: string
  relayId: string
  service: string
  toolbarActions: React.ReactNode
}) {
  const backend = React.useMemo<TerminalBackend>(() => {
    const target = { appId, relayId, service }
    return {
      claim: (input) => claimAppTerminal({ data: { ...target, ...input } }),
      noun: "app",
      restart: () => restartAppTerminal({ data: target }),
      streamUrl: (size) => appTerminalStreamUrl({ ...target, ...size }),
      write: (sessionId, data) =>
        writeAppTerminal({ data: { ...target, data, sessionId } }),
    }
  }, [appId, relayId, service])
  return <TerminalSession backend={backend} toolbarActions={toolbarActions} />
}
