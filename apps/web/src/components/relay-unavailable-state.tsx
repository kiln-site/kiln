import {
  Cable,
  CircleAlert,
  CirclePause,
  RefreshCw,
  Settings,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import type { RelayConnectionSummary } from "@/lib/relay-selectors"

export function RelayUnavailableState({
  connection,
  canConfigure,
  onRetry,
  onConfigure,
}: {
  connection: Exclude<RelayConnectionSummary, { status: "connected" }>
  canConfigure: boolean
  onRetry: () => void
  onConfigure: () => void
}) {
  const paused = connection.status === "paused"
  const configured = connection.status !== "unconfigured"
  return (
    <main className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-background px-5 py-10">
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage:
            "radial-gradient(circle at center, black 0%, transparent 72%)",
        }}
      />
      <section className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-card/80 shadow-2xl shadow-black/15 backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <span className="type-technical-label flex items-center gap-2 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.65)]" />
            Control plane status
          </span>
          <span className="type-technical-label text-amber-400">
            {paused ? "Paused" : configured ? "Disconnected" : "Setup required"}
          </span>
        </div>
        <div className="p-6 sm:p-8">
          <div className="grid size-12 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/8 text-amber-300">
            {paused ? (
              <CirclePause className="size-5" />
            ) : configured ? (
              <CircleAlert className="size-5" />
            ) : (
              <Cable className="size-5" />
            )}
          </div>
          <p className="type-technical-label mt-6 text-primary">
            {configured ? connection.relay.name : "Relay enrollment"}
          </p>
          <h1 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
            {paused
              ? "All Relays are paused"
              : configured
                ? "Kiln is attempting to connect to your Relay(s)..."
                : "Connect your first Relay"}
          </h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            {paused
              ? "Hearth will not request live data from paused Relays. Resume a Relay in settings when you are ready to reconnect it."
              : configured
                ? "No last-known server data is available in this browser or Hearth's cache. Live navigation will return when the Relay can be reached."
                : "Hearth is ready. Add a Relay endpoint to discover and operate the game servers on another node."}
          </p>
          <div className="mt-7 flex flex-col gap-2 sm:flex-row">
            {canConfigure ? (
              <Button onClick={onConfigure}>
                <Settings /> {configured ? "Review Relay" : "Configure Relay"}
              </Button>
            ) : null}
            {paused ? null : (
              <Button variant="outline" onClick={onRetry}>
                <RefreshCw /> Check again
              </Button>
            )}
          </div>
        </div>
        <div className="type-code border-t border-border/70 bg-muted/10 px-5 py-3 text-muted-foreground">
          {paused
            ? "Paused Relays remain online; only Hearth's requests are suspended."
            : "Hearth checks configured Relays automatically. No page reload is required."}
        </div>
      </section>
    </main>
  )
}
