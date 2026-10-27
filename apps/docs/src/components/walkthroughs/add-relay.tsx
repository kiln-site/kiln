import { Check, LoaderCircle, Plus, RefreshCw } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { KilnMark } from "~/components/kiln-mark"
import type { Frame, Scene } from "~/components/walkthroughs/walkthrough"

// Adding a Relay: Hearth's Add Relay, the install command on the new
// machine, and confirming it back in Hearth. The cursor and camera aim at the
// elements marked data-target below.

const addRelayButton = { target: "add-relay" }
const copyButton = { target: "copy" }
const confirmButton = { target: "confirm" }
const fingerprint = { target: "fingerprint" }
const dialog = { target: "dialog" }

const steps = [
  "Open Infrastructure → Relays and choose Add Relay.",
  "Copy the install command.",
  "Run it on the new machine.",
  "Check the fingerprint and choose Add Relay.",
]

interface State {
  accepted: boolean
  copied: boolean
  dialog: "closed" | "install" | "confirm"
  // How many of the terminal's lines are showing.
  lines: number
}

const initial: State = {
  accepted: false,
  copied: false,
  dialog: "closed",
  lines: 0,
}

const terminalLines = [
  { kind: "command" },
  { kind: "blank" },
  { kind: "logo" },
  { kind: "step", text: "Checking Docker", took: "1s" },
  { kind: "step", text: "Downloading Kiln", took: "14s" },
  { kind: "step", text: "Starting the Relay", took: "3s" },
  { kind: "step", text: "Turning on HTTPS", took: "9s" },
  { kind: "step", text: "Reaching Hearth", took: "1s" },
  { kind: "confirm" },
  { kind: "waiting" },
] as const

const frames: Array<Frame<State>> = [
  {
    step: 0,
    duration: 900,
    scene: "app",
    camera: { scale: 1 },
    cursor: { x: 620, y: 470 },
    state: initial,
  },
  {
    step: 0,
    duration: 1100,
    scene: "app",
    camera: { scale: 1.7, focus: addRelayButton },
    cursor: addRelayButton,
  },
  {
    step: 0,
    duration: 500,
    scene: "app",
    camera: { scale: 1.7, focus: addRelayButton },
    cursor: { ...addRelayButton, click: true },
  },
  {
    step: 1,
    duration: 1200,
    scene: "app",
    camera: { scale: 1.35, focus: dialog },
    cursor: copyButton,
    state: { dialog: "install" },
  },
  {
    step: 1,
    duration: 900,
    scene: "app",
    camera: { scale: 1.35, focus: dialog },
    cursor: { ...copyButton, click: true },
    state: { copied: true },
  },
  // The new machine: paste, run, and the installer's steps, sped up.
  ...terminalLines.map((_, index): Frame<State> => ({
    step: 2,
    duration:
      index === 0 ? 900 : index === terminalLines.length - 1 ? 1400 : 320,
    scene: "terminal",
    camera: { scale: 1 },
    speed: index > 0 ? "8×" : undefined,
    state: { lines: index + 1 },
  })),
  {
    step: 3,
    duration: 1300,
    scene: "app",
    camera: { scale: 1.45, focus: fingerprint },
    cursor: fingerprint,
    state: { dialog: "confirm", copied: false },
  },
  {
    step: 3,
    duration: 900,
    scene: "app",
    camera: { scale: 1.45, focus: dialog },
    cursor: confirmButton,
  },
  {
    step: 3,
    duration: 500,
    scene: "app",
    camera: { scale: 1.45, focus: dialog },
    cursor: { ...confirmButton, click: true },
  },
  {
    step: 3,
    duration: 2600,
    scene: "app",
    camera: { scale: 1 },
    cursor: { x: 760, y: 470 },
    state: { dialog: "closed", accepted: true },
  },
]

export const addRelay: Scene<State> = {
  label: "Adding a Relay to Kiln",
  steps,
  frames,
  initial,
  views: ["app", "terminal"],
  render: ({ view, state }) =>
    view === "terminal" ? (
      <Terminal lines={state.lines} />
    ) : (
      <Hearth state={state} />
    ),
}

function Hearth({ state }: { state: State }) {
  return (
    <div className="flex size-full flex-col bg-background text-foreground">
      <BrowserBar url="kiln.example.com/infra/relays" />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-48 flex-col gap-1 border-r border-border bg-sidebar px-3 py-4 text-[13px]">
          <div className="mb-4 flex items-center gap-2 px-2">
            <KilnMark className="size-5" />
            <span className="font-semibold tracking-[-0.03em]">Kiln</span>
          </div>
          {["Overview", "Game servers", "Apps", "Databases"].map((item) => (
            <span key={item} className="px-2 py-1.5 text-muted-foreground">
              {item}
            </span>
          ))}
          <span className="bg-accent/60 px-2 py-1.5 font-medium">
            Infrastructure
          </span>
          {["Backups", "Automations", "Access"].map((item) => (
            <span key={item} className="px-2 py-1.5 text-muted-foreground">
              {item}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 px-7 py-5">
          <div className="text-xl font-semibold tracking-[-0.03em]">
            Infrastructure
          </div>
          <div className="mt-4 flex items-center justify-between border-b border-border text-[13px]">
            <div className="flex gap-5">
              {["Overview", "Relays", "Game servers", "Apps", "Domains"].map(
                (tab) => (
                  <span
                    key={tab}
                    className={cn(
                      "pb-2.5",
                      tab === "Relays"
                        ? "border-b-2 border-primary font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {tab}
                  </span>
                )
              )}
            </div>
            <span
              data-target="add-relay"
              className="mb-2 flex h-8 items-center gap-1.5 bg-primary px-3 font-medium text-primary-foreground"
            >
              <Plus className="size-3.5" />
              Add Relay
            </span>
          </div>
          <div className="mt-4 border border-border text-[13px]">
            <div className="grid grid-cols-[2rem_1fr_9rem_10rem] gap-3 border-b border-border bg-card px-3 py-2 text-muted-foreground">
              <span />
              <span>Relay</span>
              <span>Memory</span>
              <span>Host / IP</span>
            </div>
            <RelayRow name="K100" memory="3.1 / 16 GB" host="203.0.113.10" />
            <div
              className={cn(
                "transition-[opacity,max-height] duration-500",
                state.accepted ? "max-h-12 opacity-100" : "max-h-0 opacity-0"
              )}
            >
              <RelayRow name="K101" memory="0.2 / 8 GB" host="198.51.100.24" />
            </div>
          </div>
          {state.dialog === "closed" ? null : (
            <div className="absolute inset-0 grid place-items-center bg-black/45">
              <div
                data-target="dialog"
                className="w-[34rem] border border-border bg-popover p-5 text-[13px] shadow-2xl"
              >
                <div className="text-base font-semibold">Add Relay</div>
                {state.dialog === "install" ? (
                  <InstallView copied={state.copied} />
                ) : (
                  <ConfirmView />
                )}
              </div>
            </div>
          )}
          <div
            className={cn(
              "absolute right-6 bottom-6 flex items-center gap-2 border border-border bg-popover px-4 py-3 text-[13px] shadow-xl transition-[opacity,translate] duration-500",
              state.accepted ? "opacity-100" : "translate-y-3 opacity-0"
            )}
          >
            <Check className="size-4 text-emerald-400" />
            K101 added
          </div>
        </div>
      </div>
    </div>
  )
}

function RelayRow({
  host,
  memory,
  name,
}: {
  host: string
  memory: string
  name: string
}) {
  return (
    <div className="grid grid-cols-[2rem_1fr_9rem_10rem] items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
      <span className="size-2 rounded-full bg-emerald-400" />
      <span className="font-medium">{name}</span>
      <span className="text-muted-foreground">{memory}</span>
      <span className="font-mono text-xs text-muted-foreground">{host}</span>
    </div>
  )
}

function InstallView({ copied }: { copied: boolean }) {
  return (
    <>
      <div className="mt-4 flex gap-4 border-b border-border">
        <span className="border-b-2 border-primary pb-2 font-medium">
          Install
        </span>
        <span className="pb-2 text-muted-foreground">Pairing link</span>
      </div>
      <div className="mt-4 text-muted-foreground">
        Run this on the machine to add:
      </div>
      <div className="mt-2 flex items-center gap-3 border border-border bg-background px-3 py-2.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">
          curl -fsSL https://kiln.site/install | sh -s -- --join
          &apos;https://kiln.example.com/#kj1.4Qm…&apos;
        </span>
        <span
          data-target="copy"
          className={cn(
            "shrink-0 border border-border px-2 py-1 font-sans",
            copied ? "text-emerald-400" : "text-foreground"
          )}
        >
          {copied ? "Copied" : "Copy"}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        <span className="flex-1">Waiting for the Relay</span>
        <span className="tabular-nums">30 min</span>
        <span className="flex items-center gap-1">
          <RefreshCw className="size-3" />
          New command
        </span>
      </div>
    </>
  )
}

function ConfirmView() {
  return (
    <>
      <div className="mt-4 grid grid-cols-[7rem_1fr] gap-y-2 border border-border bg-background p-3">
        <span className="text-muted-foreground">Address</span>
        <span className="font-mono text-xs">198.51.100.24</span>
        <span className="text-muted-foreground">Version</span>
        <span className="font-mono text-xs">0.9.0</span>
        <span className="text-muted-foreground">Fingerprint</span>
        <span
          data-target="fingerprint"
          className="font-mono text-xs text-primary-ink"
        >
          SHA256:9f2c…41ab
        </span>
      </div>
      <div className="mt-4 text-muted-foreground">Name</div>
      <div className="mt-1.5 border border-border bg-background px-3 py-2 text-muted-foreground">
        K101
      </div>
      <div className="mt-5 flex justify-end">
        <span
          data-target="confirm"
          className="flex h-9 items-center bg-primary px-4 font-medium text-primary-foreground"
        >
          Add Relay
        </span>
      </div>
    </>
  )
}

function Terminal({ lines }: { lines: number }) {
  const shown = terminalLines.slice(0, lines)
  return (
    <div className="flex size-full flex-col bg-[#0c0b0a] font-mono text-[15px] leading-7 text-[#e8e2dc]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        <span className="size-3 rounded-full bg-white/15" />
        <span className="size-3 rounded-full bg-white/15" />
        <span className="size-3 rounded-full bg-white/15" />
        <span className="flex-1 text-center font-sans text-xs text-white/45">
          admin@new-machine: ~
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
        {shown.map((line, index) => {
          switch (line.kind) {
            case "command":
              return (
                <div key={index} className="truncate">
                  <span className="text-[#f08a3c]">$ </span>
                  curl -fsSL https://kiln.site/install | sh -s -- --join
                  &apos;https://kiln.example.com/#kj1.4Qm…&apos;
                </div>
              )
            case "blank":
              return <div key={index}>&nbsp;</div>
            case "logo":
              return (
                <div key={index} className="mb-2 flex items-center gap-4">
                  <KilnMark className="size-10" />
                  <div className="leading-6">
                    <div className="font-bold">Kiln</div>
                    <div className="text-white/45">Add this machine</div>
                  </div>
                </div>
              )
            case "step":
              return (
                <div key={index}>
                  {"  "}
                  <span className="text-emerald-400">✓</span>{" "}
                  <span className="inline-block w-64">{line.text}</span>
                  <span className="text-white/40">{line.took}</span>
                </div>
              )
            case "confirm":
              return (
                <div key={index} className="mt-3">
                  <div>{"  "}Confirm this Relay in Hearth:</div>
                  <div>
                    {"  "}
                    <span className="text-[#f08a3c]">→</span>{" "}
                    <span className="font-bold">
                      https://kiln.example.com/…
                    </span>
                  </div>
                  <div className="text-white/45">
                    {"  "}Fingerprint SHA256:9f2c…41ab
                  </div>
                </div>
              )
            case "waiting":
              return (
                <div key={index} className="mt-3">
                  {"  "}
                  <span className="inline-block animate-spin text-[#f08a3c]">
                    ◐
                  </span>{" "}
                  Waiting for confirmation
                </div>
              )
          }
        })}
      </div>
    </div>
  )
}

function BrowserBar({ url }: { url: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <span className="size-2.5 rounded-full bg-muted-foreground/30" />
      <span className="size-2.5 rounded-full bg-muted-foreground/30" />
      <span className="size-2.5 rounded-full bg-muted-foreground/30" />
      <span className="mx-auto w-80 truncate border border-border bg-background px-3 py-0.5 text-center text-[11px] text-muted-foreground">
        {url}
      </span>
    </div>
  )
}
