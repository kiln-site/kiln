import * as React from "react"
import { createPortal } from "react-dom"
import { Result } from "effect"
import {
  keepPreviousData,
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  DatabaseOverview,
  DatabaseQueryResult,
  DatabaseSort,
  DatabaseTable,
} from "@workspace/contracts"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Code2,
  Database,
  Download,
  EllipsisVertical,
  Eye,
  Funnel,
  KeyRound,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Table2,
  TableProperties,
  TriangleAlert,
  Undo2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import { PanelResizeHandle } from "@/components/panel-resize-handle"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import { FileActionMenuItem } from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import {
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import {
  createDatabaseEditStore,
  type DatabaseEditStore,
} from "@/components/files/database/database-edit-store"
import {
  DatabaseGrid,
  type DatabaseGridColumn,
} from "@/components/files/database/database-grid"
import {
  DATABASE_PAGE_SIZE,
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
  relayFileDatabaseSource,
} from "@/components/files/database/database-source"
import {
  createDatabasePageStore,
  type DatabasePageStore,
} from "@/components/files/database/database-page-store"
import { formatByteSize } from "@/components/files/database/database-values"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { loadSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

export function DatabaseViewer({
  canWrite,
  displayPath,
  instance,
  onNotDatabase,
  onTreeExpand,
  treeCollapsed,
}: {
  canWrite: boolean
  displayPath: string
  instance: InstanceWorkspaceInstance
  onNotDatabase: () => void
  onTreeExpand: () => void
  treeCollapsed: boolean
}) {
  const source = React.useMemo(
    () =>
      relayFileDatabaseSource({
        canWrite,
        instanceId: instance.id,
        path: displayPath,
        relayId: instance.relayId,
      }),
    [canWrite, displayPath, instance.id, instance.relayId]
  )
  // The header only needs to know whether the file is writable; size and
  // mtime changes after a refetch stay inside the components that show them.
  const overviewQuery = useQuery({
    ...overviewQueryOptions(source),
    select: selectReadOnly,
  })
  const readOnly = overviewQuery.data ?? null
  const notDatabase =
    overviewQuery.isError &&
    overviewQuery.error.message.includes("not a SQLite database")
  React.useEffect(() => {
    if (notDatabase) onNotDatabase()
  }, [notDatabase, onNotDatabase])
  const writable = canWrite && readOnly === false
  const [queryOpen, setQueryOpen] = React.useState(false)
  // The workspace renders its table picker here while the sidebar is hidden.
  const [headerSlot, setHeaderSlot] = React.useState<HTMLElement | null>(null)
  const liveServer =
    instance.observedState === "running" ||
    instance.observedState === "starting"

  return (
    <section className="flex min-h-[360px] min-w-0 flex-1 flex-col bg-card">
      <div className={fileEditorHeaderClassName} data-file-toolbar>
        {treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null}
        <div className={fileEditorHeaderContentClassName}>
          <FileToolbarIdentity
            path={displayPath}
            readOnly={readOnly !== null && !writable}
          />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div ref={setHeaderSlot} className="contents" />
            <DatabaseRefreshButton source={source} />
            {readOnly !== null ? (
              <DatabaseQueryButton
                open={queryOpen}
                onOpenChange={setQueryOpen}
              />
            ) : null}
            <DatabaseOverflowMenu instance={instance} path={displayPath} />
          </div>
        </div>
      </div>

      {readOnly !== null ? (
        <DatabaseWorkspace
          key={displayPath}
          headerSlot={headerSlot}
          liveServer={liveServer}
          queryOpen={queryOpen}
          source={source}
          writable={writable}
          onQueryOpenChange={setQueryOpen}
        />
      ) : overviewQuery.isError ? (
        <DatabaseUnavailable message={overviewQuery.error.message} />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <FileWorkspaceLoadingState
            title="Opening database"
            description="Reading tables and columns from the Relay."
          />
        </div>
      )}
    </section>
  )
}

function overviewQueryOptions(source: DatabaseSource) {
  return {
    queryKey: [...source.queryKey, "overview"],
    queryFn: source.overview,
    retry: false,
    staleTime: 10_000,
  }
}

const selectReadOnly = (overview: DatabaseOverview) => overview.readOnly
const selectTables = (overview: DatabaseOverview) => overview.tables
const selectMeta = (overview: DatabaseOverview) =>
  `SQLite ${overview.engineVersion} · ${formatByteSize(overview.sizeBytes)}`
const noTables: ReadonlyArray<DatabaseTable> = []

function DatabaseMetaLabel({ source }: { source: DatabaseSource }) {
  const meta = useQuery({ ...overviewQueryOptions(source), select: selectMeta })
  return (
    <p className="type-meta min-w-0 truncate px-2 font-mono text-[0.6875rem] text-muted-foreground/75">
      {meta.data ?? ""}
    </p>
  )
}

function DatabaseQueryButton({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  return (
    <EditorTooltip content={open ? "Close query" : "Run a SQL query"}>
      <Button
        size="default"
        aria-pressed={open}
        className={cn(
          "gap-1.5 px-2.5 text-xs shadow-none",
          open && "ring-2 ring-primary/40 ring-offset-2 ring-offset-card"
        )}
        onClick={() => onOpenChange(!open)}
      >
        <Code2 className="size-[17px]" />
        Query
      </Button>
    </EditorTooltip>
  )
}

function DatabaseOverflowMenu({
  instance,
  path,
}: {
  instance: InstanceWorkspaceInstance
  path: string
}) {
  const [open, setOpen] = React.useState(false)
  const [downloadOpen, setDownloadOpen] = React.useState(false)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={open ? "secondary" : "ghost"}
            size="icon"
            aria-label="More database actions"
            aria-expanded={open}
            title="More database actions"
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
            Database actions
          </p>
          <FileActionMenuItem
            icon={<Download />}
            label="Download"
            detail="Preview size and compression"
            onClick={() => {
              setOpen(false)
              setDownloadOpen(true)
            }}
          />
        </PopoverContent>
      </Popover>
      <FileDownloadDialog
        instance={instance}
        open={downloadOpen}
        path={path}
        onOpenChange={setDownloadOpen}
      />
    </>
  )
}

function DatabaseRefreshButton({ source }: { source: DatabaseSource }) {
  const queryClient = useQueryClient()
  // Row refetches show their own indicator next to the table toolbar.
  const fetching =
    useIsFetching({ queryKey: [...source.queryKey, "overview"] }) > 0
  return (
    <EditorTooltip content="Reload database">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Reload database"
        onClick={() =>
          void queryClient.invalidateQueries({ queryKey: source.queryKey })
        }
      >
        <RefreshCw className={cn("size-[17px]", fetching && "animate-spin")} />
      </Button>
    </EditorTooltip>
  )
}

function DatabaseUnavailable({ message }: { message: string }) {
  return (
    <div className="grid flex-1 place-items-center px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          <Database className="size-5" />
        </div>
        <p className="text-sm font-semibold">Database unavailable</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {message}
        </p>
      </div>
    </div>
  )
}

function DatabaseWorkspace({
  headerSlot,
  liveServer,
  onQueryOpenChange,
  queryOpen,
  source,
  writable,
}: {
  headerSlot: HTMLElement | null
  liveServer: boolean
  onQueryOpenChange: (open: boolean) => void
  queryOpen: boolean
  source: DatabaseSource
  writable: boolean
}) {
  // Structurally shared, so a refetch with the same schema keeps this array
  // and the workspace does not re-render.
  const tables =
    useQuery({ ...overviewQueryOptions(source), select: selectTables }).data ??
    noTables
  const [tableName, setTableName] = React.useState<string | null>(
    () => tables.find(({ kind }) => kind === "table")?.name ?? null
  )
  const [tablesCollapsed, setTablesCollapsed] = useStoredFlag(
    tablesCollapsedStorageKey
  )
  const revealTables = React.useCallback(
    () => setTablesCollapsed(false),
    [setTablesCollapsed]
  )
  // An empty database has nothing to browse, so start in the query console.
  const emptyDatabase = tables.length === 0
  React.useLayoutEffect(() => {
    if (emptyDatabase) onQueryOpenChange(true)
  }, [emptyDatabase, onQueryOpenChange])
  const [editStore, setEditStore] = React.useState(createDatabaseEditStore)
  const [pendingSwitch, setPendingSwitch] = React.useState<string | null>(null)
  const [sql, setSql] = React.useState("")
  const table =
    tables.find(({ name }) => name === tableName) ?? tables[0] ?? null

  function selectTable(name: string) {
    const leavingTable = name !== table?.name
    if (leavingTable && editStore.getPendingCount() > 0) {
      setPendingSwitch(name)
      return
    }
    if (leavingTable) setEditStore(createDatabaseEditStore())
    setTableName(name)
    onQueryOpenChange(false)
  }
  const selectedName = queryOpen ? null : (table?.name ?? null)

  return (
    <div className="flex min-h-0 flex-1">
      {tablesCollapsed ? null : (
        <DatabaseTableList
          source={source}
          tables={tables}
          selected={selectedName}
          onCollapse={() => setTablesCollapsed(true)}
          onSelect={selectTable}
        />
      )}
      {tablesCollapsed && headerSlot
        ? createPortal(
            <HeaderTablePicker
              queryOpen={queryOpen}
              selected={selectedName}
              tables={tables}
              onSelect={selectTable}
            />,
            headerSlot
          )
        : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTablePicker
          tables={tables}
          value={selectedName}
          onSelect={(name) =>
            name === null ? onQueryOpenChange(true) : selectTable(name)
          }
        />
        {queryOpen ? (
          <SqlConsole
            tables={tables}
            onRevealTables={tablesCollapsed ? revealTables : null}
            source={source}
            sql={sql}
            writable={writable}
            onSqlChange={setSql}
          />
        ) : table ? (
          <TableView
            key={table.name}
            editStore={editStore}
            liveServer={liveServer}
            source={source}
            table={table}
            writable={writable}
            onRevealTables={tablesCollapsed ? revealTables : null}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-xs text-muted-foreground">
            This database has no tables yet. Use Query to create one.
          </div>
        )}
      </div>
      <Dialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSwitch(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {table?.name} has changes that have not been saved to the
              database.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSwitch(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingSwitch) return
                setEditStore(createDatabaseEditStore())
                setTableName(pendingSwitch)
                onQueryOpenChange(false)
                setPendingSwitch(null)
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const DatabaseTableList = React.memo(function DatabaseTableList({
  onCollapse,
  onSelect,
  selected,
  source,
  tables,
}: {
  onCollapse: () => void
  onSelect: (name: string) => void
  selected: string | null
  source: DatabaseSource
  tables: ReadonlyArray<DatabaseTable>
}) {
  const panelRef = React.useRef<HTMLElement>(null)

  return (
    <aside
      ref={panelRef}
      className="relative hidden w-[var(--database-tables-width,14rem)] shrink-0 flex-col bg-muted/[0.06] md:flex"
    >
      <TableListBody
        className="min-h-0 flex-1"
        tables={tables}
        selected={selected}
        trailing={
          <EditorTooltip content="Collapse tables">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse tables"
              onClick={onCollapse}
            >
              <PanelLeftClose className="size-[18px]" />
            </Button>
          </EditorTooltip>
        }
        onSelect={onSelect}
      />
      <div className="flex min-h-10 shrink-0 items-center border-t border-border px-1.5 py-1">
        <DatabaseMetaLabel source={source} />
      </div>
      {/* Same edge as the file tree: a hairline the resize handle overlaps. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-30 w-px bg-border/80"
      />
      <TablesPanelResizeHandle panelRef={panelRef} />
    </aside>
  )
})

const tablesPanelWidthStorageKey = "kiln:database-tables-width"
const tablesPanelDefaultWidth = 224
const tablesPanelMinWidth = 160
const tablesPanelMaxWidth = 440

function clampTablesPanelWidth(width: number, panel: HTMLElement | null) {
  const workspace = panel?.parentElement?.getBoundingClientRect().width
  const maximum = workspace
    ? Math.max(
        tablesPanelMinWidth,
        Math.min(tablesPanelMaxWidth, Math.floor(workspace * 0.4))
      )
    : tablesPanelMaxWidth
  return Math.min(maximum, Math.max(tablesPanelMinWidth, Math.round(width)))
}

// Mirrors the file tree resize: widths are written straight to a CSS
// variable during the drag so nothing re-renders, then saved on release.
function TablesPanelResizeHandle({
  panelRef,
}: {
  panelRef: React.RefObject<HTMLElement | null>
}) {
  const handleRef = React.useRef<HTMLDivElement>(null)
  const width = React.useRef(tablesPanelDefaultWidth)
  const session = React.useRef<{
    pointerId: number
    startWidth: number
    startX: number
  } | null>(null)
  const frame = React.useRef<number | null>(null)

  const apply = React.useCallback(
    (next: number) => {
      const panel = panelRef.current
      width.current = clampTablesPanelWidth(next, panel)
      panel?.style.setProperty("--database-tables-width", `${width.current}px`)
      handleRef.current?.setAttribute("aria-valuenow", String(width.current))
      return width.current
    },
    [panelRef]
  )
  const persist = (value: number) => {
    Result.try(() =>
      window.localStorage.setItem(tablesPanelWidthStorageKey, String(value))
    )
  }

  React.useLayoutEffect(() => {
    const stored = Result.try(() =>
      Number(window.localStorage.getItem(tablesPanelWidthStorageKey))
    )
    const saved = Result.isSuccess(stored) ? stored.success : 0
    apply(saved > 0 ? saved : tablesPanelDefaultWidth)
  }, [apply])

  function finish(pointerId?: number) {
    if (pointerId !== undefined && session.current?.pointerId !== pointerId) {
      return
    }
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
    session.current = null
    document.documentElement.style.removeProperty("user-select")
    handleRef.current?.removeAttribute("data-resizing")
    persist(width.current)
  }

  return (
    <PanelResizeHandle
      ref={handleRef}
      aria-label="Resize tables"
      aria-valuemin={tablesPanelMinWidth}
      aria-valuemax={tablesPanelMaxWidth}
      aria-valuenow={tablesPanelDefaultWidth}
      className="flex"
      onPointerDown={(event) => {
        if (event.button !== 0 || !panelRef.current) return
        event.preventDefault()
        session.current = {
          pointerId: event.pointerId,
          startWidth: panelRef.current.getBoundingClientRect().width,
          startX: event.clientX,
        }
        document.documentElement.style.userSelect = "none"
        event.currentTarget.dataset.resizing = "true"
        Result.try(() => event.currentTarget.setPointerCapture(event.pointerId))
      }}
      onPointerMove={(event) => {
        const active = session.current
        if (!active || active.pointerId !== event.pointerId) return
        const next = active.startWidth + event.clientX - active.startX
        if (frame.current !== null) window.cancelAnimationFrame(frame.current)
        frame.current = window.requestAnimationFrame(() => {
          frame.current = null
          apply(next)
        })
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onLostPointerCapture={() => {
        if (session.current) finish()
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        persist(apply(tablesPanelDefaultWidth))
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 16
        const next =
          event.key === "ArrowLeft"
            ? width.current - step
            : event.key === "ArrowRight"
              ? width.current + step
              : event.key === "Home"
                ? tablesPanelMinWidth
                : event.key === "End"
                  ? tablesPanelMaxWidth
                  : null
        if (next === null) return
        event.preventDefault()
        persist(apply(next))
      }}
    />
  )
}

// Filter box plus grouped table/view list, shared by the sidebar and the
// header picker shown while the sidebar is collapsed.
function TableListBody({
  className,
  onSelect,
  selected,
  tables: allTables,
  trailing,
}: {
  className?: string
  onSelect: (name: string) => void
  selected: string | null
  tables: ReadonlyArray<DatabaseTable>
  trailing?: React.ReactNode
}) {
  const [filter, setFilter] = React.useState("")
  const normalized = filter.trim().toLowerCase()
  const visible = normalized
    ? allTables.filter(({ name }) => name.toLowerCase().includes(normalized))
    : allTables
  const tables = visible.filter(({ kind }) => kind === "table")
  const views = visible.filter(({ kind }) => kind === "view")
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pr-1 pl-2.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={filter}
          placeholder={`Filter ${allTables.length} tables`}
          aria-label="Filter tables"
          className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => setFilter(event.target.value)}
        />
        {trailing}
      </div>
      <nav
        className="min-h-0 flex-1 overflow-y-auto py-1.5"
        aria-label="Tables"
      >
        <TableListSection
          label="Tables"
          tables={tables}
          selected={selected}
          onSelect={onSelect}
        />
        <TableListSection
          label="Views"
          tables={views}
          selected={selected}
          onSelect={onSelect}
        />
        {visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No tables match.
          </p>
        ) : null}
      </nav>
    </div>
  )
}

function HeaderTablePicker({
  onSelect,
  queryOpen,
  selected,
  tables,
}: {
  onSelect: (name: string) => void
  queryOpen: boolean
  selected: string | null
  tables: ReadonlyArray<DatabaseTable>
}) {
  const [open, setOpen] = React.useState(false)
  const current = queryOpen
    ? undefined
    : tables.find(({ name }) => name === selected)
  const Icon = current?.kind === "view" ? Eye : Table2
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="default"
          className="hidden max-w-56 gap-1.5 px-2.5 text-xs md:inline-flex"
          aria-label="Choose table"
        >
          <Icon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">{current?.name ?? "Tables"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={8}
        className="flex h-[min(24rem,70vh)] w-64 flex-col p-0"
      >
        <TableListBody
          className="min-h-0 flex-1"
          tables={tables}
          selected={selected}
          onSelect={(name) => {
            setOpen(false)
            onSelect(name)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

const tablesCollapsedStorageKey = "kiln:database-tables-collapsed"

function useStoredFlag(key: string) {
  const [value, setValue] = React.useState(() => {
    const stored = Result.try(() => window.localStorage.getItem(key))
    return Result.isSuccess(stored) && stored.success === "true"
  })
  const update = React.useCallback(
    (next: boolean) => {
      setValue(next)
      Result.try(() => window.localStorage.setItem(key, String(next)))
    },
    [key]
  )
  return [value, update] as const
}

function TablesRevealButton({ onClick }: { onClick: () => void }) {
  return (
    <EditorTooltip content="Show tables">
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden shrink-0 text-primary md:inline-flex"
        aria-label="Show tables"
        onClick={onClick}
      >
        <PanelLeftOpen className="size-[18px]" />
      </Button>
    </EditorTooltip>
  )
}

function MobileTablePicker({
  onSelect,
  tables,
  value,
}: {
  onSelect: (name: string | null) => void
  tables: ReadonlyArray<DatabaseTable>
  value: string | null
}) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-2 md:hidden">
      <select
        aria-label="Table"
        value={value ?? ""}
        className="h-7 min-w-0 flex-1 border border-input/80 bg-input/15 px-2 text-xs outline-none focus:border-primary/45"
        onChange={(event) => onSelect(event.target.value || null)}
      >
        {tables.map(({ kind, name }) => (
          <option key={name} value={name}>
            {kind === "view" ? `${name} (view)` : name}
          </option>
        ))}
        <option value="">Query</option>
      </select>
    </div>
  )
}

function TableListSection({
  label,
  onSelect,
  selected,
  tables,
}: {
  label: string
  onSelect: (name: string) => void
  selected: string | null
  tables: ReadonlyArray<DatabaseTable>
}) {
  if (tables.length === 0) return null
  return (
    <div className="mb-1.5">
      <p className="type-technical-label px-3 pt-1.5 pb-1 text-[0.625rem] text-muted-foreground/70">
        {label}
      </p>
      {tables.map((table) => {
        const active = table.name === selected
        const Icon = table.kind === "view" ? Eye : Table2
        return (
          <button
            key={table.name}
            type="button"
            aria-current={active ? "true" : undefined}
            title={table.name}
            className={cn(
              "flex h-7 w-full items-center gap-2 px-3 text-left text-xs outline-none hover:bg-accent/45 focus-visible:bg-accent/55",
              active
                ? "bg-primary/12 font-medium text-primary"
                : "text-foreground/85"
            )}
            onClick={() => onSelect(table.name)}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                active ? "text-primary" : "text-muted-foreground"
              )}
            />
            <span className="truncate">{table.name}</span>
          </button>
        )
      })}
    </div>
  )
}

const TableView = React.memo(function TableView({
  editStore,
  liveServer,
  onRevealTables,
  source,
  table,
  writable,
}: {
  editStore: DatabaseEditStore
  liveServer: boolean
  onRevealTables: (() => void) | null
  source: DatabaseSource
  table: DatabaseTable
  writable: boolean
}) {
  const [offset, setOffset] = React.useState(0)
  const [sort, setSort] = React.useState<DatabaseSort | null>(null)
  const [searchText, setSearchText] = React.useState("")
  const search = useDebouncedValue(searchText.trim(), 250)
  const [pagedSearch, setPagedSearch] = React.useState(search)
  if (pagedSearch !== search) {
    setPagedSearch(search)
    setOffset(0)
  }
  const changeSort = React.useCallback((next: DatabaseSort | null) => {
    setSort(next)
    setOffset(0)
  }, [])
  const editable =
    writable && table.kind === "table" && table.rowIdentity !== null

  const [pageStore] = React.useState(createDatabasePageStore)
  const rowsQueryKey = React.useMemo(
    () => [...source.queryKey, "rows", table.name],
    [source.queryKey, table.name]
  )
  const status = React.useSyncExternalStore(
    pageStore.subscribe,
    pageStore.getStatus,
    pageStore.getStatus
  )
  const error = React.useSyncExternalStore(
    pageStore.subscribe,
    pageStore.getError,
    pageStore.getError
  )
  const [hiddenColumns, setHiddenColumns] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Rows come from the page store in schema order; hidden columns are skipped
  // by pointing each visible column at its value's original position.
  const columns = React.useMemo<Array<DatabaseGridColumn>>(
    () =>
      table.columns.flatMap((column, sourceIndex) =>
        hiddenColumns.has(column.name)
          ? []
          : [
              {
                name: column.name,
                primaryKey: column.primaryKey > 0,
                readOnly: column.generated,
                sourceIndex,
                type: column.type || null,
              },
            ]
      ),
    [hiddenColumns, table.columns]
  )

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
        {onRevealTables ? (
          <TablesRevealButton onClick={onRevealTables} />
        ) : null}
        {editable ? (
          <Button
            size="sm"
            className="shrink-0 shadow-none"
            onClick={() => editStore.insertRow()}
          >
            <Plus /> Insert Row
          </Button>
        ) : null}
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 border border-input/80 bg-input/15 px-2 focus-within:border-primary/45 sm:max-w-64">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={searchText}
            placeholder={`Search ${table.name}`}
            aria-label={`Search ${table.name}`}
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <ColumnVisibilityMenu
          columns={table.columns}
          hidden={hiddenColumns}
          onHiddenChange={setHiddenColumns}
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <FetchingIndicator queryKey={rowsQueryKey} />
        </div>
      </div>

      <RowsQuerySync
        offset={offset}
        pageStore={pageStore}
        queryKey={rowsQueryKey}
        search={search}
        sort={sort}
        source={source}
        table={table.name}
      />
      {status === "error" ? (
        <DatabaseUnavailable message={error ?? "Could not read rows"} />
      ) : status === "success" ? (
        <DatabaseGrid
          ariaLabel={`${table.name} rows`}
          columns={columns}
          editStore={editable ? editStore : null}
          emptyMessage={
            search ? "No rows match this search." : "This table is empty."
          }
          page={pageStore}
          sort={sort}
          onSortChange={changeSort}
        />
      ) : (
        <div className="grid flex-1 place-items-center">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      <TableFooter
        editStore={editStore}
        editable={editable}
        liveServer={liveServer}
        offset={offset}
        pageStore={pageStore}
        readOnlyReason={
          !writable
            ? null
            : table.kind === "view"
              ? "Views are read-only"
              : table.rowIdentity === null
                ? "No primary key; read-only"
                : null
        }
        rowsQueryKey={rowsQueryKey}
        source={source}
        table={table}
        onOffsetChange={setOffset}
      />
    </>
  )
})

// Keeps the query subscription out of TableView: it renders nothing and only
// pushes results into the page store, where rows pick up their own changes.
function RowsQuerySync({
  offset,
  pageStore,
  queryKey,
  search,
  sort,
  source,
  table,
}: {
  offset: number
  pageStore: DatabasePageStore
  queryKey: ReadonlyArray<unknown>
  search: string
  sort: DatabaseSort | null
  source: DatabaseSource
  table: string
}) {
  const query = useQuery({
    queryKey: [
      ...queryKey,
      offset,
      sort?.column ?? null,
      sort?.direction ?? null,
      search,
    ],
    queryFn: () =>
      source.rows({
        limit: DATABASE_PAGE_SIZE,
        offset,
        table,
        ...(search ? { search } : {}),
        ...(sort ? { sort } : {}),
      }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 5_000,
  })
  const { data, error } = query
  React.useLayoutEffect(() => {
    if (data) {
      pageStore.setPage({
        error: null,
        keys: data.keys,
        offset: data.offset,
        rows: data.rows,
        status: "success",
        total: data.total,
        totalCapped: data.totalCapped,
      })
    } else if (error) {
      pageStore.setPage({
        ...pageStore.getPage(),
        error: error.message,
        status: "error",
      })
    }
  }, [data, error, pageStore])
  return null
}

function FetchingIndicator({ queryKey }: { queryKey: ReadonlyArray<unknown> }) {
  const fetching = useIsFetching({ queryKey }) > 0
  return fetching ? (
    <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
  ) : null
}

function ColumnVisibilityMenu({
  columns,
  hidden,
  onHiddenChange,
}: {
  columns: ReadonlyArray<DatabaseTable["columns"][number]>
  hidden: ReadonlySet<string>
  onHiddenChange: (hidden: ReadonlySet<string>) => void
}) {
  const visibleCount = columns.length - hidden.size
  function toggle(name: string) {
    const next = new Set(hidden)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onHiddenChange(next)
  }
  return (
    <Popover>
      <EditorTooltip
        content={
          hidden.size > 0
            ? `${visibleCount} of ${columns.length} columns shown`
            : "Choose columns"
        }
      >
        <PopoverTrigger asChild>
          <Button
            variant={hidden.size > 0 ? "secondary" : "ghost"}
            size="icon-sm"
            className={cn(
              "relative shrink-0",
              hidden.size > 0 && "text-primary"
            )}
            aria-label="Choose columns"
          >
            <Funnel className="size-4" />
          </Button>
        </PopoverTrigger>
      </EditorTooltip>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={7}
        collisionPadding={8}
        className="flex max-h-[min(26rem,70vh)] w-60 flex-col p-1"
      >
        <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
          <p className="type-technical-label text-muted-foreground">Columns</p>
          <button
            type="button"
            className="text-xs text-primary outline-none hover:underline focus-visible:underline disabled:pointer-events-none disabled:opacity-40"
            disabled={hidden.size === 0}
            onClick={() => onHiddenChange(new Set())}
          >
            Show all
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {columns.map((column) => {
            const shown = !hidden.has(column.name)
            // Keep at least one column visible.
            const locked = shown && visibleCount === 1
            return (
              <button
                key={column.name}
                type="button"
                role="menuitemcheckbox"
                aria-checked={shown}
                disabled={locked}
                className="flex h-8 w-full items-center gap-2 px-2 text-left text-xs outline-none hover:bg-popover-accent/75 focus-visible:bg-popover-accent disabled:opacity-50"
                onClick={() => toggle(column.name)}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center border",
                    shown
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input"
                  )}
                >
                  {shown ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{column.name}</span>
                <span className="type-code truncate text-[0.6875rem] text-muted-foreground uppercase">
                  {column.type}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TableStructureButton({ table }: { table: DatabaseTable }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => setOpen(true)}
      >
        <TableProperties /> Structure
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-3xl">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="flex items-center gap-2">
              <TableProperties className="size-4 text-primary" />
              {table.name}
            </DialogTitle>
            <DialogDescription>
              {table.kind === "view" ? "View" : "Table"} structure ·{" "}
              {table.columns.length}{" "}
              {table.columns.length === 1 ? "column" : "columns"}
            </DialogDescription>
          </DialogHeader>
          <TableStructure table={table} />
        </DialogContent>
      </Dialog>
    </>
  )
}

function TableFooter({
  editStore,
  editable,
  liveServer,
  offset,
  onOffsetChange,
  pageStore,
  readOnlyReason,
  rowsQueryKey,
  source,
  table,
}: {
  editStore: DatabaseEditStore
  editable: boolean
  liveServer: boolean
  offset: number
  onOffsetChange: (offset: number) => void
  pageStore: DatabasePageStore
  readOnlyReason: string | null
  rowsQueryKey: ReadonlyArray<unknown>
  source: DatabaseSource
  table: DatabaseTable
}) {
  const pageRows = React.useSyncExternalStore(
    pageStore.subscribe,
    pageStore.getRowCount,
    pageStore.getRowCount
  )
  const total = React.useSyncExternalStore(
    pageStore.subscribe,
    pageStore.getTotal,
    pageStore.getTotal
  )
  const totalCapped = React.useSyncExternalStore(
    pageStore.subscribe,
    pageStore.getTotalCapped,
    pageStore.getTotalCapped
  )
  const pending = React.useSyncExternalStore(
    editStore.subscribe,
    editStore.getPendingCount,
    editStore.getPendingCount
  )
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: () => source.mutate(table.name, editStore.toChanges()),
    onSuccess: async () => {
      editStore.discard()
      showToast({
        message: `Saved changes to ${table.name}`,
        type: "success",
      })
      // Only this table's rows can have changed; refetched rows are
      // structurally shared, so just the edited rows re-render.
      await queryClient.invalidateQueries({ queryKey: rowsQueryKey })
    },
    onError: (error) => showToast({ message: error.message, type: "error" }),
  })

  React.useEffect(() => {
    if (!editable) return
    function handleSaveShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== "s" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return
      }
      event.preventDefault()
      if (editStore.getPendingCount() > 0 && !save.isPending) save.mutate()
    }
    window.addEventListener("keydown", handleSaveShortcut)
    return () => window.removeEventListener("keydown", handleSaveShortcut)
  }, [editStore, editable, save])

  const first = pageRows === 0 ? 0 : offset + 1
  const last = offset + pageRows
  const hasNext = totalCapped
    ? pageRows === DATABASE_PAGE_SIZE
    : last < (total ?? 0)

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/10 px-2 py-1">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="First page"
          disabled={offset === 0}
          onClick={() => onOffsetChange(0)}
        >
          <ChevronsLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={offset === 0}
          onClick={() =>
            onOffsetChange(Math.max(0, offset - DATABASE_PAGE_SIZE))
          }
        >
          <ChevronLeft />
        </Button>
        <span className="type-code px-1.5 text-[0.75rem] text-muted-foreground tabular-nums">
          {first.toLocaleString()}–{last.toLocaleString()} of{" "}
          {total === null
            ? "…"
            : `${total.toLocaleString()}${totalCapped ? "+" : ""}`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={!hasNext}
          onClick={() => onOffsetChange(offset + DATABASE_PAGE_SIZE)}
        >
          <ChevronRight />
        </Button>
      </div>

      {readOnlyReason ? (
        <span className="type-meta text-muted-foreground">
          {readOnlyReason}
        </span>
      ) : null}

      {pending > 0 ? (
        <div className="ml-auto flex items-center gap-2">
          {liveServer ? (
            <EditorTooltip content="Plugins may cache or overwrite rows while the server runs. Stop the server for reliable edits.">
              <span className="type-meta hidden items-center gap-1 text-amber-500 lg:flex">
                <TriangleAlert className="size-3.5" /> Server running
              </span>
            </EditorTooltip>
          ) : null}
          <span className="type-meta text-muted-foreground tabular-nums">
            {pending} pending {pending === 1 ? "change" : "changes"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() => editStore.discard()}
          >
            <Undo2 /> Discard
          </Button>
          <Button
            size="sm"
            disabled={save.isPending}
            aria-keyshortcuts="Control+S Meta+S"
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}
            Save
          </Button>
        </div>
      ) : null}
      <div className={cn("flex items-center", pending === 0 && "ml-auto")}>
        <TableStructureButton table={table} />
      </div>
    </div>
  )
}

function TableStructure({ table }: { table: DatabaseTable }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Column</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Nullable</th>
            <th className="px-3 py-2 font-medium">Default</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((column) => (
            <tr key={column.name} className="border-b border-border/45">
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5 font-medium">
                  {column.primaryKey > 0 ? (
                    <KeyRound className="size-3 text-primary" />
                  ) : null}
                  {column.name}
                  {column.generated ? (
                    <span className="type-meta text-muted-foreground">
                      generated
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="type-code px-3 py-2 text-muted-foreground uppercase">
                {column.type || "—"}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {column.nullable ? "Yes" : "No"}
              </td>
              <td className="type-code px-3 py-2 text-muted-foreground">
                {column.defaultValue ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {table.sql ? (
        <div className="border-t border-border p-3">
          <p className="type-technical-label mb-2 text-[0.625rem] text-muted-foreground">
            Definition
          </p>
          <pre className="type-code overflow-x-auto bg-muted/20 p-3 text-[0.75rem] leading-relaxed whitespace-pre-wrap text-foreground/85">
            {table.sql}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function SqlConsole({
  onRevealTables,
  onSqlChange,
  source,
  sql,
  tables,
  writable,
}: {
  onRevealTables: (() => void) | null
  onSqlChange: (sql: string) => void
  source: DatabaseSource
  sql: string
  tables: ReadonlyArray<DatabaseTable>
  writable: boolean
}) {
  const queryClient = useQueryClient()
  const [allowWrites, setAllowWrites] = React.useState(false)
  const sqlRef = React.useRef(sql)
  sqlRef.current = sql
  const run = useMutation({
    mutationFn: (statement: string) =>
      source.query(statement, writable && allowWrites),
    onSuccess: async (result) => {
      if (result.changes !== null) {
        await queryClient.invalidateQueries({ queryKey: source.queryKey })
      }
    },
  })
  const runQuery = React.useCallback(() => {
    const statement = sqlRef.current.trim()
    if (!statement || run.isPending) return
    run.mutate(statement)
  }, [run])

  const placeholder = tables[0]
    ? `SELECT * FROM "${tables[0].name}" LIMIT 100;`
    : "SELECT sqlite_version();"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        {onRevealTables ? (
          <TablesRevealButton onClick={onRevealTables} />
        ) : null}
        <span className="flex items-center gap-1.5 px-1 text-xs font-medium">
          <Code2 className="size-3.5 text-primary" /> Query
        </span>
        <div className="ml-auto flex items-center gap-3">
          {writable ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={allowWrites}
                aria-label="Allow writes"
                onCheckedChange={setAllowWrites}
              />
              Allow writes
            </label>
          ) : null}
          <Button
            size="sm"
            disabled={run.isPending || !sql.trim()}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={runQuery}
          >
            {run.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Play />
            )}
            Run
          </Button>
        </div>
      </div>
      <div
        className="relative h-44 shrink-0 overflow-hidden border-b border-border"
        onKeyDownCapture={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.stopPropagation()
            runQuery()
          }
        }}
      >
        {sql ? null : (
          <span className="type-code pointer-events-none absolute top-[5px] left-12 z-10 text-[0.8125rem] text-muted-foreground/45">
            {placeholder}
          </span>
        )}
        <React.Suspense
          fallback={
            <div className="grid h-full place-items-center">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <SyntaxCodeEditor
            ariaLabel="SQL query"
            disabled={false}
            fontSize={13}
            onChange={onSqlChange}
            onSearchOpenChange={ignoreSearchOpenChange}
            originalValue=""
            path="query.sql"
            redactSensitive={false}
            readOnly={false}
            searchOpen={false}
            searchQuery=""
            showChanges={false}
            value={sql}
            wrapLines
          />
        </React.Suspense>
      </div>
      <SqlResult
        error={run.error}
        result={run.data ?? null}
        writesHint={writable && !allowWrites}
      />
    </div>
  )
}

const ignoreSearchOpenChange = () => undefined

function SqlResult({
  error,
  result,
  writesHint,
}: {
  error: Error | null
  result: DatabaseQueryResult | null
  writesHint: boolean
}) {
  const columns = React.useMemo<Array<DatabaseGridColumn>>(
    () => result?.columns.map(({ name, type }) => ({ name, type })) ?? [],
    [result?.columns]
  )
  const page = React.useMemo(
    () =>
      createDatabasePageStore({
        rows: result?.rows ?? [],
        status: "success",
      }),
    [result?.rows]
  )
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-start gap-2 p-3 text-xs text-destructive">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0">
          <p className="type-code whitespace-pre-wrap">{error.message}</p>
          {writesHint && /read-only/iu.test(error.message) ? (
            <p className="mt-1.5 text-muted-foreground">
              Turn on Allow writes to run statements that change data.
            </p>
          ) : null}
        </div>
      </div>
    )
  }
  if (!result) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center text-xs text-muted-foreground">
        Run a query with ⌘/Ctrl + Enter. Results are limited to{" "}
        {DATABASE_QUERY_MAX_ROWS.toLocaleString()} rows.
      </div>
    )
  }
  return (
    <>
      {result.columns.length > 0 ? (
        <DatabaseGrid
          ariaLabel="Query results"
          columns={columns}
          editStore={null}
          emptyMessage="The query returned no rows."
          page={page}
        />
      ) : (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">
          {result.changes === null
            ? "Query finished."
            : `${result.changes.toLocaleString()} ${result.changes === 1 ? "row" : "rows"} changed.`}
        </div>
      )}
      <div className="type-code flex h-7 shrink-0 items-center gap-3 border-t border-border bg-muted/10 px-3 text-[0.6875rem] text-muted-foreground">
        {result.columns.length > 0 ? (
          <span>
            {result.rows.length.toLocaleString()}
            {result.truncated ? "+" : ""} rows
          </span>
        ) : null}
        <span>{result.durationMs} ms</span>
      </div>
    </>
  )
}

function useDebouncedValue<TValue>(value: TValue, delayMs: number) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs, value])
  return debounced
}
