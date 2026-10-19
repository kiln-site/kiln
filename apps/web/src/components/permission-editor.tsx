import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Layers, Plus, TriangleAlert, X } from "lucide-react"
import type {
  AccessPermission,
  PermissionScopeType,
  PermissionSelection,
} from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Command,
  CommandBareInput,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import { Kbd } from "@workspace/ui/components/kbd"
import { cn } from "@workspace/ui/lib/utils"
import {
  isDestructive,
  isHostLevel,
  permissionDefinition,
  permissionNode,
  permissionNodeOption,
  permissionNodeOptions,
  permissionsIncluding,
  searchPermissionNodes,
  selectionKey,
  tryExpandSelections,
} from "@/lib/permission-nodes"
import type { ResourceScope } from "@/lib/resource-permissions"

/** Where an assignment applies, shown as `relay = M23`, `game server = Test`. */
export interface PermissionContext {
  scope: ResourceScope
  relayName?: string
  resourceName?: string
}

interface LinkablePreset {
  id: string
  name: string
  selections: ReadonlyArray<PermissionSelection>
}
interface LinkableDefault {
  key: string
  name: string
  description: string
  selections: ReadonlyArray<PermissionSelection>
}
/** What the signed-in user may grant in a context; `getResourceAccess` fits. */
export interface PermissionAccess {
  permissions: ReadonlyArray<AccessPermission>
  supportedCapabilities?: ReadonlyArray<string>
  presets?: ReadonlyArray<LinkablePreset>
  defaults?: ReadonlyArray<LinkableDefault>
}

export interface PermissionAssignment {
  selections: Array<PermissionSelection>
  presetIds: Array<string>
  builtinKeys: Array<string>
}

export interface PermissionTarget extends PermissionAssignment {
  key: string
  context: PermissionContext
  access?: PermissionAccess
  /** Why entries can't be added here yet: loading, failed, or not allowed. */
  notice?: string
  /** Shown beside the context, such as a pending invitation. */
  status?: { label: string; tone: "neutral" | "info" | "warning" }
  /** Why this context is read-only, such as ownership. */
  locked?: string
}

type Item =
  | { kind: "node"; selection: PermissionSelection }
  | {
      kind: "preset"
      id: string
      builtin: boolean
      name: string
      description?: string
      selections: ReadonlyArray<PermissionSelection>
    }

interface Row {
  id: string
  target: PermissionTarget
  item: Item
  /** The entry no longer applies to this resource and must be removed. */
  unsupported: boolean
  included: number
}

interface Focus {
  targetKey: string
  item: Item
}

/**
 * Permission entries as typed nodes, LuckPerms-style, beside a details pane.
 * Each entry belongs to a context, the resource it is granted on; new entries
 * go to `activeTarget`. Omit `onChange` for a read-only view.
 *
 * The editor fills its parent and never changes size: the entries and the
 * details pane scroll on their own, and suggestions replace the entries while
 * typing, so nothing moves as you hover or type.
 */
export const PermissionEditor = memo(function PermissionEditor({
  targets,
  onChange,
  activeTarget,
  onActiveTargetChange,
  onRemoveTarget,
  contextPicker,
  grouped = targets.length > 1 || !!contextPicker,
  presets = false,
  disabled = false,
  emptyMessage = "No permissions yet.",
  className,
}: {
  targets: ReadonlyArray<PermissionTarget>
  onChange?: (key: string, assignment: PermissionAssignment) => void
  activeTarget?: string
  onActiveTargetChange?: (key: string) => void
  onRemoveTarget?: (key: string) => void
  /** Adds a context; shown beside the active one. */
  contextPicker?: ReactNode
  grouped?: boolean
  presets?: boolean
  disabled?: boolean
  emptyMessage?: string
  className?: string
}) {
  const editable = !!onChange && !disabled
  const [focus, setFocus] = useState<Focus | null>(null)
  const [preview, setPreview] = useState<Focus | null>(null)
  const target =
    targets.find((candidate) => candidate.key === activeTarget) ??
    targets.find((candidate) => !candidate.locked) ??
    targets[0]

  const rowsByTarget = useMemo(
    () => targets.map((entry) => [entry, targetRows(entry)] as const),
    [targets]
  )
  const unsupportedCount = useMemo(
    () =>
      rowsByTarget.reduce(
        (count, [, rows]) =>
          count + rows.filter((row) => row.unsupported).length,
        0
      ),
    [rowsByTarget]
  )

  const remove = useCallback(
    (row: Row) => {
      const { target: current, item } = row
      onChange?.(current.key, {
        selections:
          item.kind === "node"
            ? current.selections.filter(
                (selection) =>
                  selectionKey(selection) !== selectionKey(item.selection)
              )
            : current.selections,
        presetIds:
          item.kind === "preset" && !item.builtin
            ? current.presetIds.filter((id) => id !== item.id)
            : current.presetIds,
        builtinKeys:
          item.kind === "preset" && item.builtin
            ? current.builtinKeys.filter((key) => key !== item.id)
            : current.builtinKeys,
      })
      setFocus((value) =>
        value?.targetKey === current.key && itemId(value.item) === itemId(item)
          ? null
          : value
      )
    },
    [onChange]
  )
  const select = useCallback(
    (row: Row) => setFocus({ targetKey: row.target.key, item: row.item }),
    []
  )
  const activate = useCallback(
    (key: string) => {
      onActiveTargetChange?.(key)
      setFocus(null)
    },
    [onActiveTargetChange]
  )
  const add = useCallback(
    (current: PermissionTarget, item: Item) => {
      onChange?.(current.key, {
        selections:
          item.kind === "node"
            ? [...current.selections, item.selection]
            : current.selections,
        presetIds:
          item.kind === "preset" && !item.builtin
            ? [...current.presetIds, item.id]
            : current.presetIds,
        builtinKeys:
          item.kind === "preset" && item.builtin
            ? [...current.builtinKeys, item.id]
            : current.builtinKeys,
      })
      setFocus({ targetKey: current.key, item })
    },
    [onChange]
  )

  const shown = preview ?? focus
  const shownTarget =
    (shown && targets.find((candidate) => candidate.key === shown.targetKey)) ||
    target
  const focusedId = focus ? `${focus.targetKey}|${itemId(focus.item)}` : null
  const canAdd = editable && !!target && !target.locked

  const entries = (
    <div className="pb-3">
      {unsupportedCount ? (
        <p
          role="alert"
          className="type-support m-3 mb-0 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {unsupportedCount === 1
            ? "One saved entry is unavailable for its resource. Remove it before saving."
            : `${unsupportedCount} saved entries are unavailable for their resources. Remove them before saving.`}
        </p>
      ) : null}
      {grouped ? (
        rowsByTarget.length ? (
          rowsByTarget.map(([entry, rows]) => (
            <ContextGroup
              key={entry.key}
              target={entry}
              rows={rows}
              active={entry.key === target?.key && !!onActiveTargetChange}
              focusedId={focusedId}
              editable={editable}
              onActivate={onActiveTargetChange ? activate : undefined}
              onRemoveTarget={editable ? onRemoveTarget : undefined}
              onSelect={select}
              onRemove={remove}
            />
          ))
        ) : (
          <EmptyEntries>{emptyMessage}</EmptyEntries>
        )
      ) : rowsByTarget[0]?.[1].length ? (
        <RowList
          rows={rowsByTarget[0][1]}
          focusedId={focusedId}
          editable={editable}
          onSelect={select}
          onRemove={remove}
        />
      ) : (
        <EmptyEntries>{emptyMessage}</EmptyEntries>
      )}
    </div>
  )

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,34%)] overflow-hidden lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-1",
        className
      )}
    >
      <section
        aria-label="Permission entries"
        className="flex min-h-0 min-w-0 flex-col lg:border-r"
      >
        {canAdd ? (
          <NodeInput
            target={target}
            presets={presets}
            grouped={grouped}
            contextPicker={contextPicker}
            onAdd={add}
            onPreview={setPreview}
          >
            {entries}
          </NodeInput>
        ) : (
          <>
            {!grouped && target && hasContextNames(target.context) ? (
              <div className="type-meta flex h-11 shrink-0 items-center gap-1.5 border-b px-4 text-muted-foreground">
                on <ContextChips context={target.context} />
              </div>
            ) : grouped && editable && contextPicker ? (
              <div className="flex h-[6.75rem] shrink-0 items-center gap-3 border-b px-4">
                <p className="type-support flex-1 text-muted-foreground">
                  Choose a Relay, game server, or database, then add what they
                  can do there.
                </p>
                {contextPicker}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {entries}
            </div>
          </>
        )}
      </section>
      <aside
        aria-label="Permission details"
        className="min-h-0 min-w-0 overflow-y-auto overscroll-contain border-t bg-muted/15 p-4 lg:border-t-0"
      >
        {shown && shownTarget ? (
          <ItemDetails
            item={shown.item}
            target={shownTarget}
            previewing={!!preview}
            showContext={grouped}
          />
        ) : (
          <EffectiveSummary target={shownTarget} grouped={grouped} />
        )}
      </aside>
    </div>
  )
})

function EmptyEntries({ children }: { children: ReactNode }) {
  return (
    <p className="type-support mx-3 mt-3 rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground">
      {children}
    </p>
  )
}

function targetRows(target: PermissionTarget): Array<Row> {
  const scopeType = target.context.scope.resourceType
  const capabilities = target.access?.supportedCapabilities
  const rows: Array<Row> = []
  const presetRow = (item: Item & { kind: "preset" }) => {
    const expanded = tryExpandSelections(
      item.selections,
      scopeType,
      capabilities
    )
    rows.push({
      id: `${target.key}|${itemId(item)}`,
      target,
      item,
      unsupported: false,
      included: expanded?.length ?? 0,
    })
  }
  for (const key of target.builtinKeys) {
    const preset = target.access?.defaults?.find((entry) => entry.key === key)
    presetRow({
      kind: "preset",
      id: key,
      builtin: true,
      name: preset?.name ?? key,
      description: preset?.description,
      selections: preset?.selections ?? [],
    })
  }
  for (const id of target.presetIds) {
    const preset = target.access?.presets?.find((entry) => entry.id === id)
    presetRow({
      kind: "preset",
      id,
      builtin: false,
      name: preset?.name ?? "Preset",
      selections: preset?.selections ?? [],
    })
  }
  const nodes: Array<Row> = target.selections.map((selection) => {
    // Until the context's catalog loads, every saved entry counts as usable.
    const expanded = target.access
      ? tryExpandSelections([selection], scopeType, capabilities)
      : []
    const item: Item = { kind: "node", selection }
    return {
      id: `${target.key}|${itemId(item)}`,
      target,
      item,
      unsupported: !expanded,
      included: expanded
        ? Math.max(
            0,
            expanded.length - (selection.kind === "permission" ? 1 : 0)
          )
        : 0,
    }
  })
  nodes.sort((a, b) =>
    nodeName(a.item) < nodeName(b.item)
      ? -1
      : nodeName(a.item) > nodeName(b.item)
        ? 1
        : 0
  )
  return [...rows, ...nodes]
}

const itemId = (item: Item) =>
  item.kind === "node"
    ? selectionKey(item.selection)
    : `${item.builtin ? "builtin" : "preset"}:${item.id}`
const nodeName = (item: Item) =>
  item.kind === "node" ? permissionNode(item.selection) : item.name
function rowCopy(item: Item): [string, string] {
  if (item.kind === "preset")
    return [item.name, item.builtin ? "Kiln preset" : "Preset"]
  const option = permissionNodeOption(item.selection)
  return [option.node, option.label]
}

const ContextGroup = memo(function ContextGroup({
  target,
  rows,
  active,
  focusedId,
  editable,
  onActivate,
  onRemoveTarget,
  onSelect,
  onRemove,
}: {
  target: PermissionTarget
  rows: ReadonlyArray<Row>
  active: boolean
  focusedId: string | null
  editable: boolean
  onActivate?: (key: string) => void
  onRemoveTarget?: (key: string) => void
  onSelect: (row: Row) => void
  onRemove: (row: Row) => void
}) {
  const label = contextLabel(target.context)
  const heading = (
    <>
      <ContextChips context={target.context} />
      {target.status ? (
        <Badge
          variant={target.status.tone === "warning" ? "outline" : "secondary"}
          className={cn(
            target.status.tone === "warning" &&
              "border-amber-500/40 text-amber-700 dark:text-amber-300",
            target.status.tone === "info" &&
              "bg-sky-500/10 text-sky-700 dark:text-sky-300"
          )}
        >
          {target.status.label}
        </Badge>
      ) : null}
      <span className="type-meta ml-auto shrink-0 text-muted-foreground tabular-nums">
        {target.locked
          ? "All permissions"
          : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
      </span>
    </>
  )
  return (
    <section aria-label={label} className="mt-3 first:mt-0">
      <header
        data-active={active || undefined}
        className="sticky top-0 z-10 flex h-10 items-center gap-1 border-y bg-[color-mix(in_oklab,var(--surface-overlay)_94%,transparent)] pr-1.5 backdrop-blur first:border-t-0 data-active:shadow-[inset_2px_0_0_var(--primary)]"
      >
        {onActivate && !target.locked ? (
          <button
            type="button"
            aria-pressed={active}
            aria-label={`Add entries to ${label}`}
            onClick={() => onActivate(target.key)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
          >
            {heading}
          </button>
        ) : (
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
            {heading}
          </div>
        )}
        {onRemoveTarget && !target.locked ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemoveTarget(target.key)}
          >
            <X />
          </Button>
        ) : null}
      </header>
      {target.locked ? (
        <p className="type-support px-4 py-3 text-muted-foreground">
          {target.locked}
        </p>
      ) : rows.length ? (
        <RowList
          rows={rows}
          focusedId={focusedId}
          editable={editable}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ) : (
        <p className="type-support px-4 py-3 text-muted-foreground">
          {target.notice ??
            (editable
              ? active
                ? "Nothing here yet. Add a permission above."
                : "Nothing here yet."
              : "No permissions.")}
        </p>
      )}
    </section>
  )
})

const RowList = memo(function RowList({
  rows,
  focusedId,
  editable,
  onSelect,
  onRemove,
}: {
  rows: ReadonlyArray<Row>
  focusedId: string | null
  editable: boolean
  onSelect: (row: Row) => void
  onRemove: (row: Row) => void
}) {
  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row) => (
        <EntryRow
          key={row.id}
          row={row}
          focused={row.id === focusedId}
          editable={editable}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </ul>
  )
})

const EntryRow = memo(function EntryRow({
  row,
  focused,
  editable,
  onSelect,
  onRemove,
}: {
  row: Row
  focused: boolean
  editable: boolean
  onSelect: (row: Row) => void
  onRemove: (row: Row) => void
}) {
  const { item } = row
  const [title, subtitle] = rowCopy(item)
  const host =
    item.kind === "node" &&
    item.selection.kind === "permission" &&
    isHostLevel(item.selection.key)
  return (
    <li
      data-focused={focused}
      className="flex h-12 items-center gap-1 pr-1.5 transition-colors hover:bg-muted/35 data-[focused=true]:bg-muted/60"
    >
      <button
        type="button"
        aria-pressed={focused}
        onClick={() => onSelect(row)}
        className="flex h-full min-w-0 flex-1 items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        {item.kind === "preset" ? (
          <Layers className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
        <span className="min-w-0 flex-1">
          {item.kind === "node" ? (
            <code className="type-code block truncate text-foreground">
              {title}
            </code>
          ) : (
            <span className="type-body block truncate font-medium">
              {title}
            </span>
          )}
          <span className="type-meta block truncate text-muted-foreground">
            {subtitle}
          </span>
        </span>
        {host ? <Badge variant="destructive">Host access</Badge> : null}
        {row.unsupported ? (
          <Badge variant="destructive">Unavailable here</Badge>
        ) : null}
        {row.included > 0 ? (
          <span className="type-meta shrink-0 text-muted-foreground tabular-nums">
            {item.kind === "preset"
              ? `${row.included} permission${row.included === 1 ? "" : "s"}`
              : `+${row.included}`}
          </span>
        ) : null}
      </button>
      {editable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${title}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onRemove(row)}
        >
          <X />
        </Button>
      ) : null}
    </li>
  )
})

interface Suggestion {
  value: string
  item: Item
  node: string
  label: string
  group: string
  blocked?: string
}

function NodeInput({
  target,
  presets,
  grouped,
  contextPicker,
  onAdd,
  onPreview,
  children,
}: {
  target: PermissionTarget
  presets: boolean
  grouped: boolean
  contextPicker?: ReactNode
  onAdd: (target: PermissionTarget, item: Item) => void
  onPreview: (focus: Focus | null) => void
  children: ReactNode
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const scopeType = target.context.scope.resourceType
  const access = target.access
  const capabilities = access?.supportedCapabilities

  const suggestions = useMemo(() => {
    if (!access) return []
    const grantable = new Set(access.permissions)
    const added = new Set(target.selections.map(selectionKey))
    const linkedPresets = new Set(target.presetIds)
    const linkedDefaults = new Set(target.builtinKeys)
    const effective = new Set(
      tryExpandSelections(
        [
          ...target.selections.filter(
            (selection) =>
              tryExpandSelections([selection], scopeType, capabilities) !== null
          ),
          ...linkedSelections(target),
        ],
        scopeType,
        capabilities
      ) ?? []
    )
    const blockedReason = (
      selections: ReadonlyArray<PermissionSelection>
    ): string | undefined | null => {
      const expanded = tryExpandSelections(selections, scopeType, capabilities)
      if (!expanded) return null
      if (expanded.some((key) => !grantable.has(key))) return "Can't grant"
      return undefined
    }
    const result: Array<Suggestion> = []
    if (presets) {
      for (const preset of access.defaults ?? []) {
        const blocked = blockedReason(preset.selections)
        if (blocked === null) continue
        result.push({
          value: `builtin:${preset.key}`,
          item: {
            kind: "preset",
            id: preset.key,
            builtin: true,
            name: preset.name,
            description: preset.description,
            selections: preset.selections,
          },
          node: preset.name,
          label: preset.description,
          group: "Presets",
          blocked: linkedDefaults.has(preset.key) ? "Added" : blocked,
        })
      }
      for (const preset of access.presets ?? []) {
        const blocked = blockedReason(preset.selections)
        if (blocked === null) continue
        result.push({
          value: `preset:${preset.id}`,
          item: {
            kind: "preset",
            id: preset.id,
            builtin: false,
            name: preset.name,
            selections: preset.selections,
          },
          node: preset.name,
          label: "Saved preset for this resource",
          group: "Presets",
          blocked: linkedPresets.has(preset.id) ? "Added" : blocked,
        })
      }
    }
    for (const option of permissionNodeOptions) {
      if (!option.scopeTypes.includes(scopeType)) continue
      const blocked = blockedReason([option.selection])
      if (blocked === null) continue
      result.push({
        value: selectionKey(option.selection),
        item: { kind: "node", selection: option.selection },
        node: option.node,
        label: option.label,
        group: option.group,
        blocked: added.has(selectionKey(option.selection))
          ? "Added"
          : option.selection.kind === "permission" &&
              effective.has(option.selection.key as AccessPermission)
            ? "Included"
            : blocked,
      })
    }
    return result
  }, [access, target, scopeType, capabilities, presets])

  const matches = useMemo(() => {
    const text = query.trim()
    if (!text) return suggestions
    const byValue = new Map(suggestions.map((entry) => [entry.value, entry]))
    const presetMatches = suggestions.filter(
      (entry) =>
        entry.item.kind === "preset" &&
        entry.node.toLowerCase().includes(text.toLowerCase())
    )
    const nodeMatches = searchPermissionNodes(text).flatMap((option) => {
      const entry = byValue.get(selectionKey(option.selection))
      return entry ? [entry] : []
    })
    return [...presetMatches, ...nodeMatches]
  }, [query, suggestions])

  const sections = useMemo(() => {
    if (query.trim())
      return matches.length ? [["Matches", matches] as const] : []
    const groups = new Map<string, Array<Suggestion>>()
    for (const entry of matches)
      groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
    return [...groups]
  }, [matches, query])

  const outOfContext = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text || matches.length) return null
    return searchPermissionNodes(text)[0] ?? null
  }, [matches.length, query])

  const preview = useCallback(
    (value: string) => {
      setHighlighted(value)
      const entry = suggestions.find((candidate) => candidate.value === value)
      onPreview(entry ? { targetKey: target.key, item: entry.item } : null)
    },
    [suggestions, onPreview, target.key]
  )
  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    onPreview(null)
  }, [onPreview])
  function choose(entry: Suggestion) {
    if (entry.blocked) return
    onAdd(target, entry.item)
    setQuery("")
    inputRef.current?.focus()
  }

  const ready = !!access && !target.notice
  const showing = open && ready
  return (
    <Command
      shouldFilter={false}
      value={highlighted}
      onValueChange={preview}
      loop
      className="min-h-0 flex-1 rounded-none! bg-transparent p-0"
    >
      <div className="shrink-0 space-y-2 border-b p-3">
        {grouped ? (
          <div className="flex h-8 min-w-0 items-center gap-2">
            <span className="type-meta shrink-0 text-muted-foreground">
              Adding to
            </span>
            <span className="min-w-0 flex-1 overflow-hidden">
              <ContextChips context={target.context} />
            </span>
            {contextPicker}
          </div>
        ) : null}
        <div className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input/90 bg-input/20 px-3 transition-[border-color,box-shadow] focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/35">
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <CommandBareInput
            ref={inputRef}
            data-dialog-focus
            aria-label="Add permission"
            placeholder={
              ready
                ? presets
                  ? "Add a permission or preset, e.g. instance.files.*"
                  : "Add a permission, e.g. instance.files.*"
                : (target.notice ?? "Loading permissions…")
            }
            disabled={!ready}
            value={query}
            onValueChange={(value) => {
              setQuery(value)
              setOpen(true)
            }}
            onClick={() => setOpen(true)}
            onBlur={close}
            onKeyDown={(event) => {
              if (event.key === "Escape" && open) {
                event.preventDefault()
                event.stopPropagation()
                close()
              } else if (!open && event.key === "ArrowDown") setOpen(true)
            }}
            className="type-input h-full min-w-0 flex-1 bg-transparent font-mono outline-hidden placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          {showing ? (
            <Kbd className="hidden sm:inline-flex">esc</Kbd>
          ) : (
            <Kbd className="hidden sm:inline-flex">↵</Kbd>
          )}
        </div>
      </div>
      {showing ? (
        <CommandList
          aria-label="Permission suggestions"
          className="max-h-none min-h-0 flex-1 overscroll-contain p-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          <CommandEmpty className="type-support px-4 py-6 text-left">
            {outOfContext ? (
              <>
                <code className="type-code text-foreground">
                  {outOfContext.node}
                </code>{" "}
                can't be granted on {scopeNoun(scopeType)}.{" "}
                {outOfContext.scopeTypes.includes("relay")
                  ? "Add it on a Relay instead."
                  : null}
              </>
            ) : (
              "No permissions match."
            )}
          </CommandEmpty>
          {sections.map(([group, entries]) => (
            <CommandGroup key={group} heading={group}>
              {entries.map((entry) => (
                <CommandItem
                  key={entry.value}
                  value={entry.value}
                  disabled={!!entry.blocked}
                  onSelect={() => choose(entry)}
                  className="h-12 gap-3"
                >
                  {entry.item.kind === "preset" ? (
                    <Layers className="text-muted-foreground" />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        entry.item.kind === "node"
                          ? "type-code block truncate"
                          : "block truncate font-medium"
                      }
                    >
                      {entry.node}
                    </span>
                    <span className="type-meta block truncate text-muted-foreground">
                      {entry.label}
                    </span>
                  </span>
                  {entry.blocked ? (
                    <span className="type-meta shrink-0 text-muted-foreground">
                      {entry.blocked}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      )}
    </Command>
  )
}

function linkedSelections(target: PermissionTarget) {
  const presetIds = new Set(target.presetIds)
  const builtinKeys = new Set(target.builtinKeys)
  return [
    ...(target.access?.presets ?? []).filter((preset) =>
      presetIds.has(preset.id)
    ),
    ...(target.access?.defaults ?? []).filter((preset) =>
      builtinKeys.has(preset.key)
    ),
  ].flatMap((preset) => preset.selections)
}

function ItemDetails({
  item,
  target,
  previewing,
  showContext,
}: {
  item: Item
  target: PermissionTarget
  previewing: boolean
  showContext: boolean
}) {
  const scopeType = target.context.scope.resourceType
  const capabilities = target.access?.supportedCapabilities
  const option =
    item.kind === "node" ? permissionNodeOption(item.selection) : null
  const expanded = useMemo(
    () =>
      tryExpandSelections(
        item.kind === "node" ? [item.selection] : item.selections,
        scopeType,
        capabilities
      ),
    [item, scopeType, capabilities]
  )
  const self =
    item.kind === "node" && item.selection.kind === "permission"
      ? (item.selection.key as AccessPermission)
      : null
  const includes = (expanded ?? []).filter((key) => key !== self)
  const includedBy = useMemo(
    () => (self ? permissionsIncluding(self, scopeType, capabilities) : []),
    [self, scopeType, capabilities]
  )
  const host = (expanded ?? []).filter(isHostLevel)
  const destructive = (expanded ?? []).some(isDestructive)
  const eyebrow =
    item.kind === "preset"
      ? item.builtin
        ? "Kiln preset"
        : "Preset"
      : item.selection.kind === "collection"
        ? "Group"
        : "Permission"
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <p className="type-technical-label text-muted-foreground">
          {previewing ? `${eyebrow} · preview` : eyebrow}
        </p>
        <h3 className="type-section-title">
          {item.kind === "preset" ? item.name : option!.label}
        </h3>
        {option ? (
          <code className="type-code block break-all text-muted-foreground">
            {option.node}
          </code>
        ) : null}
      </header>
      <p className="type-support text-muted-foreground">
        {item.kind === "preset"
          ? (item.description ??
            "Linked preset. Changes to the preset apply to everyone it is linked to.")
          : option!.description}
      </p>
      {host.length ? (
        <p className="type-support flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Reaches the Relay's host node, outside Kiln's own resources. Only
          grant this to people you'd trust with root on that machine.
        </p>
      ) : destructive ? (
        <p className="type-support flex gap-2 rounded-lg border p-2.5 text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Includes actions that can't be undone.
        </p>
      ) : null}
      {expanded === null ? (
        <p className="type-support text-destructive">
          Not available on {scopeNoun(scopeType)}.
        </p>
      ) : null}
      <DetailSection title="Applies on">
        {showContext ? (
          <div className="space-y-1.5">
            <ContextChips context={target.context} />
            <p className="type-support text-muted-foreground">
              {appliesOn(item, scopeType)}
            </p>
          </div>
        ) : (
          <p className="type-support text-muted-foreground">
            {appliesOn(item, scopeType)}
          </p>
        )}
      </DetailSection>
      {includes.length ? (
        <DetailSection
          title={item.kind === "preset" ? "Grants" : "Also grants"}
          count={includes.length}
        >
          <PermissionList keys={includes} />
        </DetailSection>
      ) : null}
      {includedBy.length ? (
        <DetailSection title="Included with" count={includedBy.length}>
          <PermissionList keys={includedBy.map((entry) => entry.key)} />
        </DetailSection>
      ) : null}
    </div>
  )
}

function appliesOn(item: Item, scopeType: PermissionScopeType) {
  if (item.kind === "preset" || scopeType !== "relay")
    return `This ${scopeNoun(scopeType).replace(/^(a|an) /u, "")}.`
  const option = permissionNodeOption(item.selection)
  const family =
    item.selection.kind === "permission"
      ? permissionDefinition(item.selection.key)?.family
      : undefined
  if (family === "instance")
    return "Every current and future game server on this Relay."
  if (family === "database")
    return "Every current and future database on this Relay."
  if (family === "app") return "Every app on this Relay."
  if (family === "relay") return "The Relay itself."
  return option.selection.kind === "collection"
    ? "The Relay and everything on it, now and later."
    : "The Relay and everything on it."
}

function DetailSection({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="type-label text-muted-foreground">
        {title}
        {count ? <span className="tabular-nums"> · {count}</span> : null}
      </h4>
      {children}
    </section>
  )
}

function PermissionList({ keys }: { keys: ReadonlyArray<string> }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? keys : keys.slice(0, 8)
  return (
    <>
      <ul className="space-y-1">
        {shown.map((key) => (
          <li key={key} className="min-w-0">
            <span className="type-body block truncate">
              {permissionDefinition(key)?.label ?? key}
            </span>
            <code className="type-meta block truncate font-mono text-muted-foreground">
              {key}
            </code>
          </li>
        ))}
      </ul>
      {keys.length > shown.length ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => setExpanded(true)}
        >
          Show {keys.length - shown.length} more
        </Button>
      ) : null}
    </>
  )
}

function EffectiveSummary({
  target,
  grouped,
}: {
  target?: PermissionTarget
  grouped: boolean
}) {
  const permissions = useMemo(() => {
    if (!target || target.locked) return []
    const scopeType = target.context.scope.resourceType
    const capabilities = target.access?.supportedCapabilities
    const supported = target.selections.filter(
      (selection) =>
        tryExpandSelections([selection], scopeType, capabilities) !== null
    )
    return (
      tryExpandSelections(
        [...supported, ...linkedSelections(target)],
        scopeType,
        capabilities
      ) ?? []
    )
  }, [target])
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <p className="type-technical-label text-muted-foreground">
          Effective access
        </p>
        {grouped && target ? <ContextChips context={target.context} /> : null}
        <p className="type-support text-muted-foreground">
          Select an entry to see what it allows. Use{" "}
          <code className="type-code text-foreground">*</code> or{" "}
          <code className="type-code text-foreground">instance.files.*</code> to
          include permissions Kiln adds later.
        </p>
      </header>
      {target?.locked ? (
        <p className="type-support text-muted-foreground">{target.locked}</p>
      ) : permissions.length ? (
        <DetailSection title="Permissions" count={permissions.length}>
          <PermissionList keys={permissions} />
        </DetailSection>
      ) : (
        <p className="type-support text-muted-foreground">
          Nothing granted yet.
        </p>
      )}
    </div>
  )
}

function hasContextNames(context: PermissionContext) {
  return !!(context.relayName ?? context.resourceName)
}
function contextKind(scopeType: PermissionScopeType) {
  return scopeType === "instance"
    ? "game server"
    : scopeType === "database"
      ? "database"
      : "relay"
}
function scopeNoun(scopeType: PermissionScopeType) {
  return scopeType === "instance"
    ? "a game server"
    : scopeType === "database"
      ? "a database"
      : "a Relay"
}
export function contextLabel(context: PermissionContext) {
  const relay = context.relayName ?? context.scope.relayId
  return context.scope.resourceType === "relay"
    ? `Relay ${relay}`
    : `${context.resourceName ?? context.scope.resourceId} on ${relay}`
}

export function ContextChips({ context }: { context: PermissionContext }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <ContextChip
        name="relay"
        value={context.relayName ?? context.scope.relayId}
      />
      {context.scope.resourceType !== "relay" ? (
        <ContextChip
          name={contextKind(context.scope.resourceType)}
          value={context.resourceName ?? context.scope.resourceId}
        />
      ) : null}
    </span>
  )
}

function ContextChip({ name, value }: { name: string; value: string }) {
  return (
    <span className="type-meta inline-flex h-6 max-w-48 min-w-0 items-center gap-1 rounded-md border bg-background/60 px-1.5">
      <span className="shrink-0 text-muted-foreground">{name} =</span>
      <span className="truncate text-foreground">{value}</span>
    </span>
  )
}
