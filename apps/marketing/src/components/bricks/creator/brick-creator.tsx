import * as React from "react"
import { Result } from "effect"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  History,
  RotateCcw,
} from "lucide-react"

import {
  type BrickV2,
  type BrickV2DeployType,
  type BrickV2Kind,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

import { BrickTile } from "~/components/bricks/brick-glyph"
import { CopyButton, downloadText } from "~/components/bricks/copy-button"
import { InstallPreview } from "~/components/bricks/install-preview"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  IssueStore,
  IssueStoreContext,
} from "~/components/bricks/creator/creator-fields"
import {
  BasicsSection,
  DatabaseSection,
  DeploySection,
  type Edit,
  GameSection,
  InputsSection,
} from "~/components/bricks/creator/creator-sections"
import {
  type CreatorIssue,
  type CreatorSection,
  brickIssues,
  creatorReducer,
  creatorState,
  fieldDomId,
  kindLabels,
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

  return (
    <div className="site-container py-10 sm:py-14">
      <h1 className="site-title">Create a Brick</h1>
      <p className="site-copy mt-2 max-w-xl text-muted-foreground">
        Pick what it is and how it runs. You&rsquo;ll see the install form it
        makes and its JSON as you go.
      </p>

      {draft ? (
        <button
          type="button"
          onClick={() => onOpen(draft.brick)}
          className="mt-8 flex w-full items-center gap-4 border border-primary/40 bg-primary/5 p-4 text-left transition-colors outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <History className="size-5 shrink-0 text-primary-ink" />
          <span className="min-w-0 flex-1">
            <span className="type-section-title block truncate">
              Continue {draft.brick.name || "your untitled Brick"}
            </span>
            <span className="type-meta text-muted-foreground">
              Saved in this browser {timeAgo(draft.savedAt)}
            </span>
          </span>
          <span className="type-control text-primary-ink">Continue</span>
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
            <div className="mt-4 flex flex-col gap-1.5">
              {starter.types.map((type) => (
                <Button
                  key={type}
                  variant="outline"
                  className="justify-start"
                  onClick={() => onOpen(starterBrick(starter.kind, type))}
                >
                  {brickDeployLabels[type]}
                </Button>
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
                  className="flex w-full items-center gap-3 bg-background p-3 text-left transition-colors outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
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
                      {kindLabels[listed.brick.kind]} ·{" "}
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
            <ImportButton onOpen={onOpen} />
            <Textarea
              aria-label="Paste a Brick's JSON"
              rows={8}
              spellCheck={false}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder='Paste JSON: { "format": "kiln.brick/v2", … }'
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

function ImportButton({
  onOpen,
  variant = "outline",
}: {
  onOpen: (brick: BrickV2) => void
  variant?: "outline" | "ghost"
}) {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        variant={variant}
        size={variant === "ghost" ? "sm" : "default"}
        className={variant === "outline" ? "self-start" : undefined}
        onClick={() => input.current?.click()}
      >
        <FileUp />
        {variant === "ghost" ? "Open" : "Open a .json file"}
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
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
    </>
  )
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
  inputs: "Inputs",
  deploy: "Deploy",
  kind: "Game or database",
}

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
  const edit = React.useCallback<Edit>(
    (update) => dispatch({ type: "edit", update }),
    []
  )
  const onText = React.useCallback(
    (text: string) => dispatch({ type: "text", text }),
    []
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

  const goToIssue = React.useCallback((issue: CreatorIssue) => {
    setView("edit")
    window.requestAnimationFrame(() => {
      const target =
        document.getElementById(fieldDomId(issue.path)) ??
        document.getElementById(issue.section)
      target?.scrollIntoView({ behavior: "smooth", block: "center" })
      target?.querySelector<HTMLElement>("input, textarea, button")?.focus({
        preventScroll: true,
      })
    })
  }, [])

  const iconUrl = brickIconUrl(deferred.icon)
  const inputKeys = (brick.inputs ?? []).map((input) => input.key).join(",")
  const portNames =
    brick.deploy.type === "static"
      ? ""
      : (brick.deploy.ports ?? []).map((port) => port.name).join(",")
  const fileName = `${brick.id || "brick"}.json`
  const issueCount = issues.length + (state.textProblem ? 1 : 0)
  const pane = view === "edit" ? "preview" : view

  return (
    <IssueStoreContext.Provider value={store}>
      <div className="sticky top-16 z-30 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="site-container flex h-14 items-center gap-3">
          <BrickTile
            color={deferred.color}
            iconUrl={iconUrl}
            id={deferred.id || "brick"}
            className="size-9"
          />
          <div className="min-w-0 flex-1">
            <p className="type-card-title truncate">
              {brick.name || "Untitled Brick"}
            </p>
            <button
              type="button"
              onClick={() => setView("issues")}
              className={cn(
                "type-meta flex items-center gap-1 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60",
                issueCount === 0 ? "text-emerald-400" : "text-amber-400"
              )}
            >
              {issueCount === 0 ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  Valid kiln.brick/v2
                </>
              ) : (
                <>
                  <AlertTriangle className="size-3.5" />
                  {issueCount} {issueCount === 1 ? "thing" : "things"} to fix
                </>
              )}
            </button>
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
            <span className="hidden sm:contents">
              <ImportButton onOpen={onOpen} variant="ghost" />
            </span>
            <CopyButton
              label="Copy"
              text={state.text}
              toast="Brick JSON copied"
              variant="ghost"
            />
            <Button
              size="sm"
              onClick={() => downloadText(fileName, state.text)}
            >
              <Download />
              <span className="hidden sm:inline">Download</span>
            </Button>
          </div>
        </div>
        <div
          role="tablist"
          aria-label="Creator view"
          className="site-container flex gap-px lg:hidden"
        >
          {(["edit", "preview", "json", "issues"] as const).map((option) => (
            <ViewTab
              key={option}
              active={view === option}
              onSelect={() => setView(option)}
            >
              {viewLabel(option, issueCount)}
            </ViewTab>
          ))}
        </div>
      </div>

      <div className="site-container grid gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div
          className={cn(
            "flex min-w-0 flex-col gap-6",
            view !== "edit" && "hidden lg:flex"
          )}
        >
          <BasicsSection
            author={brick.author}
            color={brick.color}
            edit={edit}
            icon={brick.icon}
            id={brick.id}
            kind={brick.kind}
            links={brick.links}
            name={brick.name}
            platforms={brick.platforms}
            summary={brick.summary}
            tags={brick.tags}
          />
          <InputsSection edit={edit} inputs={brick.inputs} />
          <DeploySection
            deploy={brick.deploy}
            edit={edit}
            inputKeys={inputKeys}
            kind={brick.kind}
          />
          {brick.kind === "game-server" ? (
            <GameSection edit={edit} game={brick.game} />
          ) : null}
          {brick.kind === "database" ? (
            <DatabaseSection
              database={brick.database}
              edit={edit}
              portNames={portNames}
            />
          ) : null}
        </div>

        <aside
          className={cn(
            "min-w-0 lg:sticky lg:top-[8.5rem] lg:flex lg:h-[calc(100dvh-9.5rem)] lg:flex-col",
            view === "edit" ? "hidden" : "flex flex-col"
          )}
        >
          <div
            role="tablist"
            aria-label="Preview"
            className="hidden gap-px border border-b-0 border-border bg-border lg:flex"
          >
            {(["preview", "json", "issues"] as const).map((option) => (
              <ViewTab
                key={option}
                active={pane === option}
                onSelect={() => setView(option)}
                boxed
              >
                {viewLabel(option, issueCount)}
              </ViewTab>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-background">
            {pane === "preview" ? (
              <div className="min-h-0 flex-1 overflow-auto">
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
    </IssueStoreContext.Provider>
  )
}

function viewLabel(view: View, issueCount: number): string {
  if (view === "edit") return "Edit"
  if (view === "preview") return "Preview"
  if (view === "json") return "JSON"
  return issueCount > 0 ? `Issues (${issueCount})` : "Issues"
}

function ViewTab({
  active,
  boxed,
  children,
  onSelect,
}: {
  active: boolean
  boxed?: boolean
  children: React.ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "type-control-sm h-10 flex-1 px-3 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset aria-selected:text-foreground",
        boxed
          ? "bg-card/60 aria-selected:bg-background"
          : "border-b-2 border-transparent aria-selected:border-primary"
      )}
    >
      {children}
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
          "type-meta border-b border-border px-4 py-2",
          problem ? "text-amber-400" : "text-muted-foreground"
        )}
      >
        {problem
          ? `The form keeps the last valid version until this is fixed: ${problem}`
          : "Edit it here or in the form; each follows the other."}
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
        <CheckCircle2 className="size-8 text-emerald-400" />
        <p className="type-section-title">Nothing to fix</p>
        <p className="type-support max-w-xs text-muted-foreground">
          It&rsquo;s a valid kiln.brick/v2 Brick. Download it, or open a pull
          request to list it in the community catalog.
        </p>
      </div>
    )
  }
  return (
    <ul className="min-h-0 flex-1 divide-y divide-border overflow-auto">
      {textProblem ? (
        <li className="px-4 py-3">
          <p className="type-label text-amber-400">JSON</p>
          <p className="type-support mt-0.5">{textProblem}</p>
        </li>
      ) : null}
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`}>
          <button
            type="button"
            onClick={() => onSelect(issue)}
            className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <span className="type-label text-muted-foreground">
              {sectionLabels[issue.section]}
              {issue.path ? (
                <code className="type-code ml-2 text-[0.75rem]">
                  {issue.path}
                </code>
              ) : null}
            </span>
            <span className="type-support">{issue.message}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
