import * as React from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { prepareFileTreeInput } from "@pierre/trees"
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import {
  Check,
  Download,
  EllipsisVertical,
  EyeOff,
  FileQuestion,
  FolderTree,
  House,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Share2,
  WrapText,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { cn } from "@workspace/ui/lib/utils"

import { DatabaseViewer } from "@/components/database-viewer/database-viewer"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import { DirectoryView } from "@/components/files/file-directory-view"
import { PanelResizeHandle } from "@/components/panel-resize-handle"
import { FileTypeIconSprite } from "@/components/files/file-type-icon"
import type { FileActionsController } from "@/components/files/file-tree-utils"
import {
  FileToolbarIdentity,
  FileTreeRevealButton,
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
} from "@/components/files/file-viewer-toolbar"
import { SyntaxCodeEditor } from "@/components/syntax-code-editor"
import { isDatabaseFilePath } from "@/lib/database-files"
import { fileLanguageForPath } from "@/lib/file-language"
import {
  mclogsShareLabel,
  mclogsShareTooltip,
} from "@/components/use-mclogs-share-action"

import { createDemoDatabaseSource } from "~/components/demos/demo-database"
import { createDemoFiles } from "~/components/demos/demo-file-index"
import { useDemoShare } from "~/components/demos/demo-share"
import { demoServer } from "~/components/demos/demo-server"
import {
  demoFiles,
  demoDatabasePath,
  demoTreePaths,
  initialFilePath,
} from "~/components/demos/editor-files"
import { onFilesDemoCommand } from "~/components/demos/files-demo-commands"

interface FileState {
  saved: string
  value: string
}

// The tree's look, as Hearth sets it in its file tree panel.
const treeStyle = {
  "--trees-selected-bg-override":
    "color-mix(in oklch, var(--primary) 20%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-bg-override": "var(--card)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-input-bg-override": "var(--background)",
  "--trees-search-bg-override": "var(--background)",
  "--trees-search-fg-override": "var(--foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-border-radius-override": "0px",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "0.75rem",
  "--trees-padding-inline-override": "0px",
  "--trees-item-padding-x-override": "5px",
  "--trees-item-margin-x-override": "0px",
  "--trees-item-row-gap-override": "4px",
  "--trees-level-gap-override": "4px",
  height: "100%",
} as React.CSSProperties

const treeLayoutCss = `
  [data-item-section="content"] { flex: 1 1 auto; }
  [data-item-section="decoration"]:empty { display: none; }
  [data-truncate-marker] { opacity: 0; }
  [data-icon-name="file-tree-icon-chevron"] { width: 14px; height: 14px; }
`

// The demo's file actions: reading only, so the menus offer what needs no
// server.
const readOnlyActions: FileActionsController = {
  busy: false,
  canWrite: false,
  instance: { id: demoServer.id, relayId: demoServer.relayId },
  request: () => {},
  move: async () => false,
}

const liveServerWarning = {
  detail:
    "Plugins may cache or overwrite rows while the server runs. Stop the server for reliable edits.",
  label: "Server running",
}

// Hearth's Files page for one server: its file tree, and what the selected
// path opens in. Folders list their contents, SQLite files open as tables,
// and text opens in the editor. Edits stay in this tab.
export default function FilesView() {
  const [demo] = React.useState(createDemoFiles)
  return (
    <QueryClientProvider client={demo.queryClient}>
      <FileTypeIconSprite />
      <Files fileIndex={demo.fileIndex} />
    </QueryClientProvider>
  )
}

function Files({
  fileIndex,
}: {
  fileIndex: ReturnType<typeof createDemoFiles>["fileIndex"]
}) {
  const [path, setPath] = React.useState(initialFilePath)
  const [redact, setRedact] = React.useState(true)
  const [wrap, setWrap] = React.useState(false)
  const [treeCollapsed, setTreeCollapsed] = React.useState(false)
  const [mobileTreeOpen, setMobileTreeOpen] = React.useState(false)
  const treeResize = useTreeResize()
  const [files, setFiles] = React.useState<Record<string, FileState>>(() =>
    Object.fromEntries(
      Object.entries(demoFiles).map(([filePath, file]) => [
        filePath,
        { saved: file.saved, value: file.edited ?? file.saved },
      ])
    )
  )
  const [preparedInput] = React.useState(() =>
    prepareFileTreeInput(demoTreePaths)
  )
  const selectPath = React.useRef((selected: string) => {
    setPath(selected)
    if (!selected.endsWith("/")) setMobileTreeOpen(false)
  })
  const { model } = useFileTree({
    preparedInput,
    initialExpansion: "closed",
    initialSelectedPaths: [initialFilePath],
    onSelectionChange: (paths) => {
      const selected = paths.at(-1)
      if (selected) selectPath.current(selected)
    },
    flattenEmptyDirectories: true,
    stickyFolders: true,
    itemHeight: 29,
    unsafeCSS: treeLayoutCss,
  })

  const file = files[path]

  // The feature list above the demo opens the tree, focuses its search, or
  // opens a file, as clicking in the demo would.
  const rootRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(
    () =>
      onFilesDemoCommand((command) => {
        const root = rootRef.current
        root?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "nearest",
        })
        const treeShown = () =>
          treeResize.panelRef.current?.checkVisibility() ?? false
        const showTree = () => {
          setTreeCollapsed(false)
          // Narrow windows show the tree over the file instead.
          if (!treeShown()) setMobileTreeOpen(true)
        }
        if (command === "open-tree") {
          if (!treeShown()) showTree()
          return
        }
        if (command === "search") {
          showTree()
          window.requestAnimationFrame(() => searchRef.current?.focus())
          return
        }
        const target =
          command === "open-nbt" ? "world/level.dat" : demoDatabasePath
        revealPath(model, target)
        setPath(target)
        setMobileTreeOpen(false)
      }),
    [model, treeResize.panelRef]
  )

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden @3xl/window:flex-row"
    >
      <aside
        ref={treeResize.panelRef}
        aria-label="Files"
        className={cn(
          "absolute inset-0 z-20 flex-col bg-card [--file-tree-width:280px] @3xl/window:relative @3xl/window:inset-auto @3xl/window:z-auto @3xl/window:w-[var(--file-tree-width)] @3xl/window:shrink-0 @3xl/window:border-r @3xl/window:border-border/80",
          mobileTreeOpen ? "flex" : "hidden",
          treeCollapsed ? "@3xl/window:hidden" : "@3xl/window:flex"
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b bg-card px-2">
          <EditorTooltip content="Files Home">
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 shadow-none"
              aria-label="Files home"
              onClick={() => {
                setPath("")
                setMobileTreeOpen(false)
              }}
            >
              <House className="size-[18px]" />
            </Button>
          </EditorTooltip>
          <TreeSearch inputRef={searchRef} model={model} />
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" aria-label="New">
              <Plus className="size-[18px]" />
            </Button>
            <EditorTooltip content="Refresh Files">
              <Button variant="ghost" size="icon-sm" aria-label="Refresh files">
                <RefreshCw className="size-[18px]" />
              </Button>
            </EditorTooltip>
            <EditorTooltip content="Collapse File Tree">
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden @3xl/window:inline-flex"
                aria-label="Collapse file tree"
                onClick={() => setTreeCollapsed(true)}
              >
                <PanelLeftClose className="size-[18px]" />
              </Button>
            </EditorTooltip>
            <Button
              variant="ghost"
              size="icon-sm"
              className="@3xl/window:hidden"
              aria-label="Close files"
              onClick={() => setMobileTreeOpen(false)}
            >
              <X className="size-[18px]" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-card py-1.5">
          <FileTree
            model={model}
            aria-label="survival-smp files"
            className="block size-full"
            style={treeStyle}
          />
        </div>
        <PanelResizeHandle
          aria-label="Resize file tree"
          aria-valuemin={treeMinWidth}
          aria-valuemax={treeMaxWidth}
          className="hidden @3xl/window:flex"
          {...treeResize.handleProps}
        />
      </aside>

      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        {path === "" || path.endsWith("/") ? (
          <DirectoryView
            actions={readOnlyActions}
            canWrite={false}
            fileIndex={fileIndex}
            path={path}
            treeCollapsed={treeCollapsed}
            uploading={false}
            onOpen={setPath}
            onTreeExpand={() => setTreeCollapsed(false)}
            onUploadFiles={async () => {}}
          />
        ) : isDatabaseFilePath(path) ? (
          <DemoDatabase
            key={path}
            path={path}
            treeCollapsed={treeCollapsed}
            onTreeExpand={() => setTreeCollapsed(false)}
          />
        ) : (
          <>
            <div className={fileEditorHeaderClassName}>
              {treeCollapsed ? (
                <FileTreeRevealButton onClick={() => setTreeCollapsed(false)} />
              ) : null}
              <div className={fileEditorHeaderContentClassName}>
                <FileToolbarIdentity path={path} />
                {file ? (
                  <EditorActions
                    file={file}
                    redact={redact}
                    wrap={wrap}
                    onRedactChange={setRedact}
                    onWrapChange={setWrap}
                    onRevert={() =>
                      setFiles((current) => ({
                        ...current,
                        [path]: { ...file, value: file.saved },
                      }))
                    }
                    onSave={() =>
                      setFiles((current) => ({
                        ...current,
                        [path]: { saved: file.value, value: file.value },
                      }))
                    }
                  />
                ) : null}
              </div>
            </div>
            {file ? (
              <DemoEditor
                key={path}
                file={file}
                path={path}
                redact={redact}
                wrap={wrap}
                onChange={(value) =>
                  setFiles((current) => ({
                    ...current,
                    [path]: { ...current[path]!, value },
                  }))
                }
              />
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
                <div className="flex max-w-xs flex-col items-center gap-2">
                  <FileQuestion className="size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">This file isn’t text</p>
                  <p className="type-support text-muted-foreground">
                    Download it to open it on your computer.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
        <button
          type="button"
          className="flex h-11 shrink-0 items-center gap-2.5 border-t bg-card px-3 text-left text-sm @3xl/window:hidden"
          aria-expanded={mobileTreeOpen}
          onClick={() => setMobileTreeOpen(true)}
        >
          <FolderTree className="size-[18px] shrink-0 text-primary" />
          Browse files
        </button>
      </section>
    </div>
  )
}

function TreeSearch({
  inputRef,
  model,
}: {
  inputRef: React.Ref<HTMLInputElement>
  model: ReturnType<typeof useFileTree>["model"]
}) {
  const search = useFileTreeSearch(model)
  return (
    <label className="flex h-full min-w-0 flex-1 items-center">
      <Search className="ml-1 size-[18px] shrink-0 text-foreground/90 md:ml-1.5" />
      <input
        ref={inputRef}
        type="search"
        value={search.value}
        placeholder="Search files…"
        aria-label="Search files"
        className="type-input h-full min-w-0 flex-1 bg-transparent px-2 text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          const value = event.target.value
          if (value) search.setValue(value)
          else search.close()
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") search.close()
          if (event.key === "Enter") {
            event.preventDefault()
            if (event.shiftKey) search.focusPreviousMatch()
            else search.focusNextMatch()
          }
        }}
      />
    </label>
  )
}

interface EditorSettings {
  redact: boolean
  wrap: boolean
  onRedactChange: (redact: boolean) => void
  onWrapChange: (wrap: boolean) => void
}

function EditorActions({
  file,
  onRevert,
  onSave,
  ...settings
}: EditorSettings & {
  file: FileState
  onRevert: () => void
  onSave: () => void
}) {
  const dirty = file.value !== file.saved
  return (
    <div className="ml-auto flex max-w-full min-w-0 shrink-0 items-center justify-end gap-1">
      <ShareButton />
      <EditorTooltip content="Download">
        <Button
          variant="ghost"
          size="icon"
          className="hidden @3xl/window:inline-flex"
          aria-label="Download file"
        >
          <Download className="size-[17px]" />
        </Button>
      </EditorTooltip>
      <EditorTooltip content={dirty ? "Save" : "Saved"}>
        <Button
          className={
            dirty
              ? "gap-1.5 px-2.5 text-xs shadow-none"
              : "gap-1.5 bg-primary/35 px-2.5 text-xs text-primary-foreground/65 shadow-none disabled:opacity-100"
          }
          aria-label={dirty ? "Save changes" : "Changes saved"}
          disabled={!dirty}
          onClick={onSave}
        >
          <Save className="size-[17px]" />
          <span>Save</span>
        </Button>
      </EditorTooltip>
      <EditorMenu dirty={dirty} onRevert={onRevert} {...settings} />
    </div>
  )
}

function EditorMenu({
  dirty,
  onRedactChange,
  onRevert,
  onWrapChange,
  redact,
  wrap,
}: EditorSettings & {
  dirty: boolean
  onRevert: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          aria-label="More file actions"
        >
          <EllipsisVertical className="size-[18px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={8}
        className="w-[min(17rem,calc(100vw-1rem))] p-1"
      >
        <p className="type-technical-label px-2 pt-1 pb-1.5 text-muted-foreground">
          File actions
        </p>
        <MenuItem
          active={wrap}
          detail={wrap ? "Keep long lines on one line" : "Fit long lines"}
          icon={<WrapText />}
          label={wrap ? "Disable line wrap" : "Enable line wrap"}
          onClick={() => onWrapChange(!wrap)}
        />
        <MenuItem
          active={redact}
          detail={
            redact
              ? "Reveal IP addresses in the editor"
              : "Hide IP addresses in the editor"
          }
          icon={<EyeOff />}
          label={redact ? "Show IPs" : "Censor IPs"}
          onClick={() => onRedactChange(!redact)}
        />
        <MenuItem
          detail="Go back to the saved file"
          disabled={!dirty}
          icon={<RotateCcw />}
          label="Discard changes"
          onClick={() => {
            onRevert()
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function MenuItem({
  active = false,
  detail,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean
  detail: string
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-2 py-2 text-left text-xs text-foreground transition-colors hover:bg-popover-accent/80 focus-visible:bg-popover-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center border [&>svg]:size-3.5 ${active ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card text-muted-foreground"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="type-meta block text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

function DemoEditor({
  file,
  onChange,
  path,
  redact,
  wrap,
}: {
  file: FileState
  onChange: (value: string) => void
  path: string
  redact: boolean
  wrap: boolean
}) {
  const ignoreSearch = React.useCallback(() => {}, [])
  // Hearth's defaults: 16px on phones, so iOS doesn't zoom in on focus.
  const fontSize = useIsMobile() ? 16 : 12
  const encoding = demoFiles[path]?.encoding
  const bytes = React.useMemo(
    () => new TextEncoder().encode(file.saved).length,
    [file.saved]
  )
  return (
    <>
      <div className="editor-grid relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <SyntaxCodeEditor
          ariaLabel={`Edit ${path}`}
          disabled={false}
          fontSize={fontSize}
          onChange={onChange}
          onSearchOpenChange={ignoreSearch}
          originalValue={file.saved}
          path={path}
          redactSensitive={redact}
          readOnly={false}
          searchOpen={false}
          searchQuery=""
          showChanges
          value={file.value}
          wrapLines={wrap}
        />
      </div>
      <div className="type-meta flex h-7 shrink-0 items-center justify-between border-t bg-muted/10 px-3 font-mono text-muted-foreground">
        <span>{encoding ?? `${bytes.toLocaleString("en-US")} BYTES`}</span>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          <span>LF</span>
          <span>{fileLanguageForPath(path).label}</span>
        </div>
      </div>
    </>
  )
}

// Hearth's database viewer on the demo's LuckPerms database.
function DemoDatabase({
  onTreeExpand,
  path,
  treeCollapsed,
}: {
  onTreeExpand: () => void
  path: string
  treeCollapsed: boolean
}) {
  const [source] = React.useState(() => createDemoDatabaseSource(path))
  const identity = React.useCallback(
    ({ readOnly }: { readOnly: boolean | null }) => (
      <FileToolbarIdentity path={path} readOnly={readOnly === true} />
    ),
    [path]
  )
  return (
    <DatabaseViewer
      editWarning={liveServerWarning}
      identity={identity}
      leading={
        treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null
      }
      source={source}
    />
  )
}

// Hearth's Share, which uploads the file to mclo.gs. It shares the demo
// link, not the file.
function ShareButton() {
  const { share, state } = useDemoShare()
  return (
    <EditorTooltip content={mclogsShareTooltip(state)}>
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        className="hidden h-8 shrink-0 gap-1.5 px-2.5 text-xs shadow-none @3xl/window:inline-flex"
        disabled={state === "uploading"}
        onClick={share}
      >
        {state === "uploading" ? (
          <LoaderCircle className="size-[17px] animate-spin" />
        ) : state === "copied" ? (
          <Check className="size-[17px]" />
        ) : (
          <Share2 className="size-[17px]" />
        )}
        <span>{state === "idle" ? "Share" : mclogsShareLabel(state)}</span>
      </Button>
    </EditorTooltip>
  )
}

const treeMinWidth = 224
const treeMaxWidth = 480
const treeDefaultWidth = 280

// Hearth's file tree handle: drag or use the arrow keys to resize the tree,
// double-click to put it back. It never takes more than 45% of the window.
function useTreeResize() {
  const panelRef = React.useRef<HTMLElement>(null)
  const width = React.useRef(treeDefaultWidth)
  const drag = React.useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  function apply(next: number) {
    const panel = panelRef.current
    const available = panel?.parentElement?.getBoundingClientRect().width ?? 0
    const maximum = Math.max(
      treeMinWidth,
      Math.min(treeMaxWidth, available * 0.45)
    )
    width.current = Math.min(maximum, Math.max(treeMinWidth, next))
    panel?.style.setProperty("--file-tree-width", `${width.current}px`)
  }

  const handleProps: React.ComponentProps<"div"> = {
    onPointerDown(event) {
      if (event.button !== 0 || !panelRef.current) return
      event.preventDefault()
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panelRef.current.getBoundingClientRect().width,
      }
      event.currentTarget.dataset.resizing = "true"
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove(event) {
      const session = drag.current
      if (session?.pointerId !== event.pointerId) return
      apply(session.startWidth + event.clientX - session.startX)
    },
    onPointerUp(event) {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current = null
      delete event.currentTarget.dataset.resizing
    },
    onLostPointerCapture(event) {
      drag.current = null
      delete event.currentTarget.dataset.resizing
    },
    onDoubleClick(event) {
      event.preventDefault()
      apply(treeDefaultWidth)
    },
    onKeyDown(event) {
      const step = event.shiftKey ? 32 : 16
      const next =
        event.key === "ArrowLeft"
          ? width.current - step
          : event.key === "ArrowRight"
            ? width.current + step
            : event.key === "Home"
              ? treeMinWidth
              : event.key === "End"
                ? treeMaxWidth
                : null
      if (next === null) return
      event.preventDefault()
      apply(next)
    },
  }

  return { handleProps, panelRef }
}

// Selects a path in the tree the way Hearth reveals one: its folders open,
// the old selection clears, and the tree scrolls to it.
function revealPath(
  model: ReturnType<typeof useFileTree>["model"],
  path: string
) {
  const segments = path.split("/")
  for (let depth = 1; depth < segments.length; depth++) {
    const parent = model.getItem(`${segments.slice(0, depth).join("/")}/`)
    if (parent && "isExpanded" in parent && !parent.isExpanded()) {
      parent.expand()
    }
  }
  for (const selected of model.getSelectedPaths()) {
    model.getItem(selected)?.deselect()
  }
  model.getItem(path)?.select()
  model.scrollToPath(path, { focus: false, offset: "nearest" })
}
