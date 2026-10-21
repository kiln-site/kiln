import * as React from "react"
import { prepareFileTreeInput } from "@pierre/trees"
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import {
  Download,
  EllipsisVertical,
  EyeOff,
  FileQuestion,
  FolderTree,
  House,
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

import { EditorTooltip } from "@/components/files/editor-tooltip"
import {
  FileToolbarIdentity,
  FileTreeRevealButton,
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
} from "@/components/files/file-viewer-toolbar"
import { SyntaxCodeEditor } from "@/components/syntax-code-editor"
import { fileLanguageForPath } from "@/lib/file-language"

import {
  demoFiles,
  demoTreePaths,
  initialFilePath,
} from "~/components/demos/editor-files"

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

// Hearth's Files page for one server: its file tree, the editor, and the
// editor's toolbar. Files open from the tree; edits stay in this tab.
export default function FilesView() {
  const [path, setPath] = React.useState(initialFilePath)
  const [redact, setRedact] = React.useState(true)
  const [wrap, setWrap] = React.useState(false)
  const [treeCollapsed, setTreeCollapsed] = React.useState(false)
  const [mobileTreeOpen, setMobileTreeOpen] = React.useState(false)
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
    if (selected.endsWith("/")) return
    setPath(selected)
    setMobileTreeOpen(false)
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

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden @3xl/window:flex-row">
      <aside
        aria-label="Files"
        className={cn(
          "absolute inset-0 z-20 flex-col bg-card @3xl/window:relative @3xl/window:inset-auto @3xl/window:z-auto @3xl/window:w-[17rem] @3xl/window:shrink-0 @3xl/window:border-r @3xl/window:border-border/80 @5xl/window:w-[19rem]",
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
            >
              <House className="size-[18px]" />
            </Button>
          </EditorTooltip>
          <TreeSearch model={model} />
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
      </aside>

      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
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
  model,
}: {
  model: ReturnType<typeof useFileTree>["model"]
}) {
  const search = useFileTreeSearch(model)
  return (
    <label className="flex h-full min-w-0 flex-1 items-center">
      <Search className="ml-1 size-[18px] shrink-0 text-foreground/90 md:ml-1.5" />
      <input
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
      <EditorTooltip content="Upload to mclo.gs">
        <Button
          variant="ghost"
          className="hidden h-8 shrink-0 gap-1.5 px-2.5 text-xs shadow-none @3xl/window:inline-flex"
        >
          <Share2 className="size-[17px]" />
          <span>Share</span>
        </Button>
      </EditorTooltip>
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
