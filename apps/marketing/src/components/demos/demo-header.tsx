import * as React from "react"
import { Check, Copy, PanelLeftIcon } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  ResourceMeter,
  ResourceMeterStrip,
  UptimeMeter,
  resourceItem,
  type ResourceId,
} from "@/components/resource-meters"
import { WorkspacePowerControls } from "@/components/workspace-power-controls"

import {
  demoServer,
  type DemoServer,
  type DemoServerState,
} from "~/components/demos/demo-server"

export type DemoView = "console" | "files"

const resourceIds: Array<ResourceId> = ["cpu", "memory", "storage", "network"]
const powerPermissions = { kill: true, restart: true, start: true, stop: true }
const viewTitles: Record<DemoView, string> = {
  console: "Console",
  files: "Files",
}

// Hearth's workspace header for a game server: its name and page, the live
// resource meters, and power controls.
export const DemoHeader = React.memo(function DemoHeader({
  server,
  state,
  view,
}: {
  server: DemoServer
  state: DemoServerState
  view: DemoView
}) {
  const running = state.observedState === "running"

  return (
    <header className="@container/workspace-header shrink-0 border-b bg-background/90 backdrop-blur-xl">
      <div className="flex items-center gap-3 px-3 py-3 sm:px-5 @[64rem]/workspace-header:min-h-20 @[64rem]/workspace-header:py-2">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {/* The demo has no sidebar; the toggle stays so the header reads
              as Hearth's. */}
          <span
            aria-hidden="true"
            className="-mr-1.5 -ml-2.5 grid size-8 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4"
          >
            <PanelLeftIcon />
          </span>
          <span className="h-8 w-px shrink-0 bg-border/80" aria-hidden="true" />
          <div className="@container min-w-0 flex-1">
            <p className="flex min-w-0 items-baseline gap-1.5 font-heading tracking-[-0.03em]">
              <span className="min-w-0 truncate text-lg font-semibold text-foreground sm:text-xl">
                {demoServer.name}
              </span>
              <span className="shrink-0 text-border">/</span>
              <span className="shrink-0 text-sm font-medium text-muted-foreground sm:text-base">
                {viewTitles[view]}
              </span>
            </p>
            <div className="type-meta mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground">
              <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
                <span>
                  {demoServer.implementation} {demoServer.version}
                </span>
                <span className="text-border">/</span>
              </span>
              <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
                <span className="font-mono">{demoServer.shortId}</span>
                <span className="text-border">/</span>
              </span>
              <AddressButton />
            </div>
          </div>
        </div>
        <ResourceMeterStrip
          columns={4}
          label="Server resource usage"
          uptime={
            <UptimeMeter
              label="Instance uptime"
              running={running}
              startedAt={state.startedAt}
            />
          }
        >
          {resourceIds.map((id) => (
            <DemoResourceMeter
              key={id}
              id={id}
              running={running}
              server={server}
            />
          ))}
        </ResourceMeterStrip>
        <WorkspacePowerControls
          action={state.action}
          killWarning="This immediately terminates the container. Unsaved world data may be lost."
          noun="server"
          powerPermissions={powerPermissions}
          target={{
            name: demoServer.name,
            observedState: state.observedState,
            provisioning: null,
          }}
          onAction={server.power}
          // Power actions play out in the console, so on Files they're off.
          relayConnected={view === "console"}
        />
      </div>
    </header>
  )
})

function DemoResourceMeter({
  id,
  running,
  server,
}: {
  id: ResourceId
  running: boolean
  server: DemoServer
}) {
  const resources = React.useSyncExternalStore(
    server.history.subscribe,
    server.history.getCurrentSnapshot,
    () => null
  )
  const resource = resourceItem(resources, id, {
    unavailable: running ? "Sampling" : "Stopped",
  })
  return <ResourceMeter resource={resource} historyStore={server.history} />
}

function AddressButton() {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1_800)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`flex min-w-0 items-center gap-1 truncate font-mono transition-colors ${copied ? "text-emerald-400" : "text-primary-ink/75 hover:text-primary-ink"}`}
          aria-label={`Copy server address ${demoServer.address}`}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(demoServer.address)
              .then(() => setCopied(true))
          }}
        >
          <span className="truncate">{demoServer.address}</span>
          {copied ? (
            <Check className="size-3 shrink-0" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {copied ? "Server address copied" : "Copy server address"}
      </TooltipContent>
    </Tooltip>
  )
}
