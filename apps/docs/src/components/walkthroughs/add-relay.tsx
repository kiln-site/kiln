import { KilnMark } from "~/components/kiln-mark"
import { HearthFrame } from "~/components/walkthroughs/hearth-frame"
import {
  type ExampleRelay,
  type RelaysDialog,
  RelaysPage,
} from "~/components/walkthroughs/hearth/relays-page"
import type { Frame, Scene } from "~/components/walkthroughs/walkthrough"

// Adding a Relay: Hearth's Add Relay, the install command on the new
// machine, and confirming it back in Hearth. Hearth is drawn with its own
// components; the cursor and camera aim at elements marked data-target.

const width = 1440
const height = 900

const existing: ExampleRelay = {
  address: "203.0.113.10",
  arch: "amd64",
  id: "F26nxjs",
  memory: "142 MiB",
  name: "K100",
}
const added: ExampleRelay = {
  address: "198.51.100.24",
  arch: "arm64",
  id: "Vj3kq9a",
  memory: "96 MiB",
  name: "K101",
}
const fingerprint = "VjZihgGhISjdNtn0HZN1D1OPLxqeFK_kfXh2VIwlthM"

const steps = [
  "Open Infrastructure → Relays and choose Add Relay.",
  "Copy the install command.",
  "Run it on the new machine.",
  "Check the fingerprint and choose Add Relay.",
]

interface State {
  dialog: RelaysDialog
  relays: Array<ExampleRelay>
  // How many of the terminal's lines are showing.
  lines: number
}

const initial: State = {
  dialog: { kind: "closed" },
  relays: [existing],
  lines: 0,
}

const confirmDialog: RelaysDialog = {
  kind: "confirm",
  address: "198.51.100.24:4100",
  build: "0.1.0",
  fingerprint,
  name: added.name,
}

const terminalLines = [
  { kind: "command" },
  { kind: "blank" },
  { kind: "logo" },
  { kind: "step", text: "Checking Docker", took: "1s" },
  { kind: "step", text: "Downloading Kiln", took: "14s" },
  { kind: "step", text: "Starting the Relay", took: "3s" },
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
    cursor: { x: 900, y: 640 },
    state: initial,
  },
  {
    step: 0,
    duration: 1100,
    scene: "app",
    camera: { scale: 2, focus: { target: "add-relay" } },
    cursor: { target: "add-relay" },
  },
  {
    step: 0,
    duration: 500,
    scene: "app",
    camera: { scale: 2, focus: { target: "add-relay" } },
    cursor: { target: "add-relay", click: true },
  },
  {
    step: 1,
    duration: 1300,
    scene: "app",
    camera: { scale: 1.75, focus: { target: "dialog" } },
    cursor: { target: "copy" },
    state: { dialog: { kind: "install", copied: false } },
  },
  {
    step: 1,
    duration: 1000,
    scene: "app",
    camera: { scale: 1.75, focus: { target: "dialog" } },
    cursor: { target: "copy", click: true },
    state: { dialog: { kind: "install", copied: true } },
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
    duration: 1400,
    scene: "app",
    camera: { scale: 1.9, focus: { target: "fingerprint" } },
    cursor: { target: "fingerprint" },
    state: { dialog: confirmDialog },
  },
  {
    step: 3,
    duration: 900,
    scene: "app",
    camera: { scale: 1.75, focus: { target: "dialog" } },
    cursor: { target: "confirm" },
  },
  {
    step: 3,
    duration: 500,
    scene: "app",
    camera: { scale: 1.75, focus: { target: "dialog" } },
    cursor: { target: "confirm", click: true },
  },
  {
    step: 3,
    duration: 2800,
    scene: "app",
    camera: { scale: 1.4, focus: { target: `relay-${added.name}` } },
    cursor: { target: `relay-${added.name}` },
    state: { dialog: { kind: "closed" }, relays: [existing, added] },
  },
]

export const addRelay: Scene<State> = {
  width,
  height,
  label: "Adding a Relay to Kiln",
  steps,
  frames,
  initial,
  views: ["app", "terminal"],
  render: ({ view, state }) =>
    view === "terminal" ? (
      <Terminal lines={state.lines} />
    ) : (
      <HearthFrame width={width} height={height}>
        <RelaysPage dialog={state.dialog} relays={state.relays} />
      </HearthFrame>
    ),
}

function Terminal({ lines }: { lines: number }) {
  const shown = terminalLines.slice(0, lines)
  return (
    <div className="flex size-full flex-col bg-[#0c0b0a] font-mono text-[22px] leading-[1.75] text-[#e8e2dc]">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-5">
        <span className="size-3.5 rounded-full bg-white/15" />
        <span className="size-3.5 rounded-full bg-white/15" />
        <span className="size-3.5 rounded-full bg-white/15" />
        <span className="flex-1 text-center font-sans text-base text-white/45">
          admin@new-machine: ~
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-9 py-7">
        {shown.map((line, index) => {
          switch (line.kind) {
            case "command":
              return (
                <div key={index} className="truncate">
                  <span className="text-[#f08a3c]">$ </span>
                  curl -fsSL https://kiln.site/install | sh -s -- --join
                  &apos;https://kiln.example.com/#kj1.bvx7…&apos;
                </div>
              )
            case "blank":
              return <div key={index}>&nbsp;</div>
            case "logo":
              return (
                <div key={index} className="mb-3 flex items-center gap-5">
                  <KilnMark className="size-14" />
                  <div className="leading-9">
                    <div className="font-bold">Kiln</div>
                    <div className="text-white/45">Add this machine</div>
                  </div>
                </div>
              )
            case "step":
              return (
                <div key={index} className="whitespace-pre">
                  {"  "}
                  <span className="text-emerald-400">✓</span>{" "}
                  <span className="inline-block w-[22rem]">{line.text}</span>
                  <span className="text-white/40">{line.took}</span>
                </div>
              )
            case "confirm":
              return (
                <div key={index} className="mt-4 whitespace-pre">
                  <div>{"  "}Confirm this Relay in Hearth:</div>
                  <div>
                    {"  "}
                    <span className="text-[#f08a3c]">→</span>{" "}
                    <span className="font-bold">
                      https://kiln.example.com/infra/relays?join=…
                    </span>
                  </div>
                  <div className="text-white/45">
                    {"  "}Fingerprint {fingerprint}
                  </div>
                </div>
              )
            case "waiting":
              return (
                <div key={index} className="mt-4 whitespace-pre">
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
