import * as React from "react"
import { Result } from "effect"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FileUp,
  History,
  MoreHorizontal,
  RotateCcw,
} from "lucide-react"

import {
  type BrickV2,
  type BrickV2DeployType,
  type BrickV2Kind,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

import { BrickGlyph, BrickTile } from "~/components/bricks/brick-glyph"
import {
  CopyButton,
  copyText,
  downloadText,
} from "~/components/bricks/copy-button"
import { InstallPreview } from "~/components/bricks/install-preview"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  IssueStore,
  IssueStoreContext,
} from "~/components/bricks/creator/creator-fields"
import type { Edit } from "~/components/bricks/creator/creator-edit"
import {
  DeployCard,
  deployIconUrl,
} from "~/components/bricks/creator/deploy-card"
import { PanelHost } from "~/components/bricks/creator/deploy-dialogs"
import { IdentityCard } from "~/components/bricks/creator/identity-card"
import { InputsCard, moveInput } from "~/components/bricks/creator/inputs-card"
import {
  type CreatorIssue,
  type CreatorPanel,
  type CreatorSection,
  brickIssues,
  creatorReducer,
  creatorState,
  fieldDomId,
  kindLabels,
  panelFor,
  readBrickText,
  starterBrick,
} from "~/components/bricks/creator/creator-state"
import { brickDeployLabels, brickIconUrl, listedBricks } from "~/lib/bricks"

const SyntaxCodeEditor = React.lazy(() =>
  import("@/components/syntax-code-editor").then((module) => ({
    default: module.SyntaxCodeEditor,
  }))
)

const DRAFT_KEY = "kiln.bricks.creator-draft"

interface Draft {
  brick: BrickV2
  savedAt: number
}

// A draft from an older format, or storage the browser blocks, reads as none.
function readDraft(): Draft | null {
  return Result.getOrElse(
    Result.try(() => {
      const stored = window.localStorage.getItem(DRAFT_KEY)
      if (!stored) return null
      const draft = JSON.parse(stored) as { brick?: unknown; savedAt?: unknown }
      const read = readBrickText(JSON.stringify(draft.brick))
      return read.brick && typeof draft.savedAt === "number"
        ? { brick: read.brick, savedAt: draft.savedAt }
        : null
    }),
    () => null
  )
}

// The creator: a start screen to pick what to make, then the workspace. The
// draft lives in this browser only, saved as it changes.
export function BrickCreator({ from }: { from: BrickV2 | undefined }) {
  const [session, setSession] = React.useState<{
    brick: BrickV2 | null
    key: number
  }>(() => ({ brick: from ? structuredClone(from) : null, key: 0 }))
  const [draft, setDraft] = React.useState<Draft | null | undefined>(undefined)

  React.useEffect(() => {
    setDraft(readDraft())
  }, [])

  const open = React.useCallback((brick: BrickV2) => {
    setSession((current) => ({ brick, key: current.key + 1 }))
    window.scrollTo({ top: 0 })
  }, [])
  const startOver = React.useCallback(() => {
    setDraft(readDraft())
    setSession((current) => ({ brick: null, key: current.key + 1 }))
    window.scrollTo({ top: 0 })
  }, [])

  if (session.brick) {
    return (
      <Workspace
        key={session.key}
        initial={session.brick}
        onOpen={open}
        onStartOver={startOver}
      />
    )
  }
  return <StartScreen draft={draft} onOpen={open} />
}

const starters: ReadonlyArray<{
  kind: BrickV2Kind
  types: ReadonlyArray<BrickV2DeployType>
  body: string
}> = [
  {
    kind: "game-server",
    types: ["image", "dockerfile", "compose"],
    body: "Something players join, with a console and files.",
  },
  {
    kind: "app",
    types: ["image", "dockerfile", "compose", "static"],
    body: "A website, API, bot, or tool, usually on a domain.",
  },
  {
    kind: "database",
    types: ["image", "dockerfile"],
    body: "Something apps connect to, with backups.",
  },
]

function StartScreen({
  draft,
  onOpen,
}: {
  draft: Draft | null | undefined
  onOpen: (brick: BrickV2) => void
}) {
  const [pasted, setPasted] = React.useState("")
  const pastedRead = pasted.trim() ? readBrickText(pasted) : null
  const [fileInput, pickFile] = useBrickFile(onOpen)

  return (
    <div className="site-container py-10 sm:py-14">
      <h1 className="site-title">Create a Brick</h1>
      <p className="site-copy mt-2 max-w-xl text-muted-foreground">
        Pick what it is and how it runs. The install form it makes and its JSON
        appear as you go.
      </p>

      {draft ? (
        <button
          type="button"
          onClick={() => onOpen(draft.brick)}
          className="mt-8 flex w-full items-center gap-4 border border-primary/40 bg-primary/5 p-4 text-left transition-colors outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/60 active:bg-primary/15"
        >
          <BrickTile
            color={draft.brick.color}
            iconUrl={brickIconUrl(draft.brick.icon)}
            id={draft.brick.id || "brick"}
          />
          <span className="min-w-0 flex-1">
            <span className="type-section-title block truncate">
              Continue {draft.brick.name || "your untitled Brick"}
            </span>
            <span className="type-meta flex items-center gap-1.5 text-muted-foreground">
              <History className="size-3" />
              Saved in this browser {timeAgo(draft.savedAt)}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-primary-ink" />
        </button>
      ) : null}

      <ul className="mt-8 grid gap-px border border-border bg-border md:grid-cols-3">
        {starters.map((starter) => (
          <li key={starter.kind} className="flex flex-col bg-background p-5">
            <h2 className="type-page-context flex items-center gap-2">
              <BrickKindIcon kind={starter.kind} className="size-5" />
              {kindLabels[starter.kind]}
            </h2>
            <p className="type-support mt-1 text-muted-foreground">
              {starter.body}
            </p>
            <div className="mt-4 flex flex-col gap-px border border-border bg-border">
              {starter.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => onOpen(starterBrick(starter.kind, type))}
                  className="group flex h-10 items-center gap-2.5 bg-background px-3 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:bg-accent/70"
                >
                  <BrickGlyph
                    className="size-4"
                    color="var(--muted-foreground)"
                    iconUrl={deployIconUrl(type)}
                    id={type}
                  />
                  <span className="type-control-sm">
                    {brickDeployLabels[type]}
                  </span>
                  <ChevronRight className="ml-auto size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className="type-page-context">
            Or start from one in the catalog
          </h2>
          <ul className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-2">
            {listedBricks.map((listed) => (
              <li key={listed.brick.id}>
                <button
                  type="button"
                  onClick={() => onOpen(structuredClone(listed.brick))}
                  className="flex w-full items-center gap-3 bg-background p-3 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:bg-accent/60"
                >
                  <BrickTile
                    color={listed.brick.color}
                    iconUrl={listed.iconUrl}
                    id={listed.brick.id}
                  />
                  <span className="min-w-0">
                    <span className="type-card-title block truncate">
                      {listed.brick.name}
                    </span>
                    <span className="type-meta block truncate text-muted-foreground">
                      {kindLabels[listed.brick.kind]},{" "}
                      {brickDeployLabels[listed.brick.deploy.type]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="type-page-context">Or open one you have</h2>
          <div className="mt-4 flex flex-col gap-3">
            <Button variant="outline" className="self-start" onClick={pickFile}>
              <FileUp />
              Open a .json file
            </Button>
            {fileInput}
            <Textarea
              aria-label="Paste a Brick's JSON"
              rows={8}
              spellCheck={false}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder='Or paste its JSON: { "format": "kiln.brick/v2", … }'
              className="font-mono text-sm"
            />
            {pastedRead && !pastedRead.brick ? (
              <p className="type-meta text-destructive">{pastedRead.problem}</p>
            ) : null}
            <Button
              disabled={!pastedRead?.brick}
              onClick={() => pastedRead?.brick && onOpen(pastedRead.brick)}
              className="self-start"
            >
              Open pasted Brick
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}

// A hidden file input that opens a Brick, and a way to show its picker.
function useBrickFile(
  onOpen: (brick: BrickV2) => void
): [React.ReactNode, () => void] {
  const ref = React.useRef<HTMLInputElement>(null)
  const pick = React.useCallback(() => ref.current?.click(), [])
  const input = (
    <input
      ref={ref}
      type="file"
      accept="application/json,.json"
      className="hidden"
      aria-hidden="true"
      tabIndex={-1}
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ""
        if (!file) return
        void file.text().then((text) => {
          const read = readBrickText(text)
          if (read.brick) onOpen(read.brick)
          else showToast({ message: read.problem, type: "error" })
        })
      }}
    />
  )
  return [input, pick]
}

function timeAgo(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(time).toLocaleDateString()
}

type View = "edit" | "preview" | "json" | "issues"

const sectionLabels: Record<CreatorSection, string> = {
  basics: "Basics",
  inputs: "Install form",
  deploy: "How it runs",
  database: "Database",
}

// How long a dialog or drawer takes to leave, before it's unmounted.
const PANEL_CLOSE_MS = 400

function Workspace({
  initial,
  onOpen,
  onStartOver,
}: {
  initial: BrickV2
  onOpen: (brick: BrickV2) => void
  onStartOver: () => void
}) {
  const [state, dispatch] = React.useReducer(
    creatorReducer,
    initial,
    creatorState
  )
  const [view, setView] = React.useState<View>("edit")
  const [panel, setPanelState] = React.useState<{
    open: boolean
    value: CreatorPanel
  } | null>(null)
  const closing = React.useRef<number | null>(null)
  const setPanel = React.useCallback((value: CreatorPanel) => {
    if (closing.current !== null) window.clearTimeout(closing.current)
    closing.current = null
    setPanelState({ open: true, value })
  }, [])
  const closePanel = React.useCallback(() => {
    setPanelState((current) =>
      current && current.open ? { ...current, open: false } : current
    )
    if (closing.current !== null) window.clearTimeout(closing.current)
    closing.current = window.setTimeout(() => {
      closing.current = null
      setPanelState(null)
    }, PANEL_CLOSE_MS)
  }, [])
  React.useEffect(
    () => () => {
      if (closing.current !== null) window.clearTimeout(closing.current)
    },
    []
  )
  const edit = React.useCallback<Edit>(
    (update) => dispatch({ type: "edit", update }),
    []
  )
  const onText = React.useCallback(
    (text: string) => dispatch({ type: "text", text }),
    []
  )
  const openInput = React.useCallback(
    (index: number) => setPanel({ kind: "input", index }),
    [setPanel]
  )
  const openDeployPanel = React.useCallback(
    (kind: Exclude<CreatorPanel["kind"], "input">) => setPanel({ kind }),
    [setPanel]
  )
  const moveOpenInput = React.useCallback(
    (offset: number) =>
      setPanelState((current) => {
        if (!current || current.value.kind !== "input") return current
        const index = current.value.index
        moveInput(edit, index, offset)
        return { ...current, value: { kind: "input", index: index + offset } }
      }),
    [edit]
  )
  const [store] = React.useState(() => new IssueStore())
  const brick = state.brick
  const deferred = React.useDeferredValue(brick)
  const issues = React.useMemo(() => brickIssues(deferred), [deferred])
  React.useEffect(() => store.set(issues), [issues, store])

  // Saved a moment after the last change, not on every keystroke.
  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      // A full or blocked storage loses only the draft.
      Result.try(() =>
        window.localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ brick, savedAt: Date.now() } satisfies Draft)
        )
      )
    }, 400)
    return () => window.clearTimeout(timeout)
  }, [brick])

  // Opens the dialog that fixes an issue, or goes to its field and marks it.
  const goToIssue = React.useCallback(
    (issue: CreatorIssue) => {
      const target = panelFor(issue.path)
      if ("panel" in target) {
        setPanel(target.panel)
        return
      }
      setView("edit")
      window.requestAnimationFrame(() => {
        const element = document.getElementById(fieldDomId(target.field))
        if (!element) return
        element.scrollIntoView({ behavior: "smooth", block: "center" })
        const control =
          element instanceof HTMLInputElement ||
          element instanceof HTMLButtonElement
            ? element
            : element.querySelector<HTMLElement>("input, textarea, button")
        if (control instanceof HTMLButtonElement) control.click()
        else control?.focus({ preventScroll: true })
        flash(element)
      })
    },
    [setPanel]
  )

  const iconUrl = brickIconUrl(deferred.icon)
  const inputKeys = (brick.inputs ?? []).map((input) => input.key).join(",")
  const fileName = `${brick.id || "brick"}.json`
  const issueCount = issues.length + (state.textProblem ? 1 : 0)
  const pane = view === "edit" ? "preview" : view
  const [fileInput, pickFile] = useBrickFile(onOpen)
  const showIssues = React.useCallback(() => setView("issues"), [])

  return (
    <IssueStoreContext.Provider value={store}>
      <div className="flex flex-col lg:h-[calc(100dvh-4rem)]">
        <div className="sticky top-16 z-30 border-b border-border bg-background/90 backdrop-blur-md lg:static">
          <div className="flex h-12 items-center gap-3 px-4 lg:px-5">
            <BrickTile
              color={deferred.color}
              iconUrl={iconUrl}
              id={deferred.id || "brick"}
              className="size-8"
            />
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <p className="type-card-title truncate">
                {brick.name || "Untitled Brick"}
              </p>
              <StatusPill count={issueCount} onClick={showIssues} />
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onStartOver}
                className="hidden sm:inline-flex"
              >
                <RotateCcw />
                Start over
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={pickFile}
                className="hidden sm:inline-flex"
              >
                <FileUp />
                Open
              </Button>
              <span className="hidden sm:contents">
                <CopyButton
                  label="Copy"
                  text={state.text}
                  toast="Brick JSON copied"
                  variant="ghost"
                />
              </span>
              <Button
                size="sm"
                onClick={() => downloadText(fileName, state.text)}
              >
                <Download />
                Download
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More"
                    className="sm:hidden"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem
                    onSelect={() => copyText(state.text, "Brick JSON copied")}
                  >
                    <Copy />
                    Copy JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={pickFile}>
                    <FileUp />
                    Open a .json file
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onStartOver}>
                    <RotateCcw />
                    Start over
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {fileInput}
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Creator view"
            className="flex border-t border-border/60 px-2 lg:hidden"
          >
            {(["edit", "preview", "json", "issues"] as const).map((option) => (
              <ViewTab
                key={option}
                active={view === option}
                count={option === "issues" ? issueCount : 0}
                onSelect={() => setView(option)}
              >
                {viewLabel(option)}
              </ViewTab>
            ))}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div
            className={cn(
              "min-h-0 min-w-0 lg:overflow-y-auto",
              view !== "edit" && "hidden lg:block"
            )}
          >
            <div className="mx-auto max-w-3xl p-4">
              <div className="border border-border bg-background">
                <IdentityCard
                  author={brick.author}
                  color={brick.color}
                  edit={edit}
                  game={brick.game}
                  icon={brick.icon}
                  id={brick.id}
                  kind={brick.kind}
                  links={brick.links}
                  name={brick.name}
                  platforms={brick.platforms}
                  summary={brick.summary}
                  tags={brick.tags}
                />
                <InputsCard
                  edit={edit}
                  inputs={brick.inputs}
                  onOpen={openInput}
                />
                <DeployCard
                  database={brick.database}
                  deploy={brick.deploy}
                  edit={edit}
                  inputKeys={inputKeys}
                  kind={brick.kind}
                  onOpen={openDeployPanel}
                />
              </div>
            </div>
          </div>

          <aside
            className={cn(
              "min-h-0 min-w-0 flex-col border-border bg-card/20 lg:flex lg:border-l",
              view === "edit" ? "hidden" : "flex"
            )}
          >
            <div
              role="tablist"
              aria-label="Preview"
              className="hidden h-11 shrink-0 border-b border-border px-2 lg:flex"
            >
              {(["preview", "json", "issues"] as const).map((option) => (
                <ViewTab
                  key={option}
                  active={pane === option}
                  count={option === "issues" ? issueCount : 0}
                  onSelect={() => setView(option)}
                >
                  {viewLabel(option)}
                </ViewTab>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {pane === "preview" ? (
                <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-5">
                  <InstallPreview
                    brick={deferred}
                    iconUrl={iconUrl}
                    layout="stacked"
                  />
                </div>
              ) : null}
              {pane === "json" ? (
                <JsonPane
                  onText={onText}
                  problem={state.textProblem}
                  text={state.text}
                />
              ) : null}
              {pane === "issues" ? (
                <IssuesPane
                  issues={issues}
                  onSelect={goToIssue}
                  textProblem={state.textProblem}
                />
              ) : null}
            </div>
          </aside>
        </div>
      </div>
      <PanelHost
        brick={brick}
        edit={edit}
        onClose={closePanel}
        onMoveInput={moveOpenInput}
        open={panel?.open ?? false}
        panel={panel?.value ?? null}
      />
    </IssueStoreContext.Provider>
  )
}

// Rings an element once, so the eye lands on it.
function flash(element: HTMLElement) {
  element.setAttribute("data-flash", "")
  const done = () => element.removeAttribute("data-flash")
  element.addEventListener("animationend", done, { once: true })
  // Reduced motion shows a still ring instead, with no animation to end.
  window.setTimeout(done, 1_400)
}

function StatusPill({
  count,
  onClick,
}: {
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={count === 0 ? "A valid kiln.brick/v2 Brick" : "Show what to fix"}
      className={cn(
        "type-label flex h-6 shrink-0 items-center gap-1 border px-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        count === 0
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/15"
          : "border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/15"
      )}
    >
      {count === 0 ? (
        <>
          <CheckCircle2 className="size-3" />
          Valid
        </>
      ) : (
        <>
          <AlertTriangle className="size-3" />
          {count} to fix
        </>
      )}
    </button>
  )
}

function viewLabel(view: View): string {
  if (view === "edit") return "Edit"
  if (view === "preview") return "Preview"
  if (view === "json") return "JSON"
  return "Issues"
}

function ViewTab({
  active,
  children,
  count,
  onSelect,
}: {
  active: boolean
  children: React.ReactNode
  count: number
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className="type-control-sm relative flex h-10 flex-1 items-center justify-center gap-1.5 px-3 text-muted-foreground transition-colors outline-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset aria-selected:text-foreground aria-selected:after:opacity-100 lg:h-auto lg:flex-none"
    >
      {children}
      {count > 0 ? (
        <span className="type-label grid h-4 min-w-4 place-items-center bg-amber-400/15 px-1 text-amber-300 tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  )
}

const noop = () => {}

function JsonPane({
  onText,
  problem,
  text,
}: {
  onText: (text: string) => void
  problem: string | null
  text: string
}) {
  return (
    <>
      <p
        className={cn(
          "type-meta border-b border-border px-4 py-2 lg:px-5",
          problem ? "text-amber-300" : "text-muted-foreground"
        )}
      >
        {problem
          ? `The form keeps the last valid version until this is fixed: ${problem}`
          : "Edit here or in the form. Each follows the other."}
      </p>
      <div className="editor-grid relative min-h-[28rem] min-w-0 flex-1 overflow-hidden lg:min-h-0">
        <React.Suspense
          fallback={
            <p className="type-support p-4 text-muted-foreground">
              Opening the editor…
            </p>
          }
        >
          <SyntaxCodeEditor
            ariaLabel="Brick JSON"
            disabled={false}
            fontSize={13}
            onChange={onText}
            onSearchOpenChange={noop}
            originalValue={text}
            path="brick.json"
            redactSensitive={false}
            readOnly={false}
            searchOpen={false}
            searchQuery=""
            showChanges={false}
            value={text}
            wrapLines={false}
          />
        </React.Suspense>
      </div>
    </>
  )
}

const sectionOrder: ReadonlyArray<CreatorSection> = [
  "basics",
  "inputs",
  "deploy",
  "database",
]

function IssuesPane({
  issues,
  onSelect,
  textProblem,
}: {
  issues: ReadonlyArray<CreatorIssue>
  onSelect: (issue: CreatorIssue) => void
  textProblem: string | null
}) {
  if (issues.length === 0 && !textProblem) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <span className="grid size-10 place-items-center border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
          <CheckCircle2 className="size-5" />
        </span>
        <p className="type-section-title mt-1">Nothing to fix</p>
        <p className="type-support max-w-xs text-muted-foreground">
          This is a valid kiln.brick/v2 Brick. Download it, or open a pull
          request to list it in the community catalog.
        </p>
      </div>
    )
  }
  const groups = sectionOrder
    .map((section) => ({
      section,
      issues: issues.filter((issue) => issue.section === section),
    }))
    .filter((group) => group.issues.length > 0)
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <p className="type-meta border-b border-border px-4 py-2 text-muted-foreground lg:px-5">
        Pick one to go where it&rsquo;s fixed.
      </p>
      {textProblem ? (
        <div className="border-b border-border px-4 py-3 lg:px-5">
          <p className="type-label text-amber-300">JSON</p>
          <p className="type-support mt-0.5">{textProblem}</p>
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.section} aria-label={sectionLabels[group.section]}>
          <h3 className="type-label flex h-8 items-center border-b border-border bg-card/40 px-4 text-muted-foreground lg:px-5">
            {sectionLabels[group.section]}
          </h3>
          <ul>
            {group.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSelect(issue)}
                  className="group flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:bg-accent/60 lg:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="type-support block">{issue.message}</span>
                    {issue.path ? (
                      <code className="type-code block truncate text-[0.75rem] text-muted-foreground">
                        {issue.path}
                      </code>
                    ) : null}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
