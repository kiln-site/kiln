import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Layers, Plus, Search, TriangleAlert, X } from "lucide-react"
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
import { Input } from "@workspace/ui/components/input"
import { Kbd } from "@workspace/ui/components/kbd"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@workspace/ui/components/popover"
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
 * Permission entries as a typed list of nodes, LuckPerms-style. Each entry
 * belongs to a context (the resource it is granted on); new entries go to
 * `addTarget`. Omit `onChange` for a read-only view.
 */
export const PermissionEditor = memo(function PermissionEditor({
  targets,
  onChange,
  addTarget,
  contextPicker,
  showContexts = false,
  presets = false,
  disabled = false,
  emptyMessage = "No permissions yet.",
}: {
  targets: ReadonlyArray<PermissionTarget>
  onChange?: (key: string, assignment: PermissionAssignment) => void
  addTarget?: string
  contextPicker?: ReactNode
  showContexts?: boolean
  presets?: boolean
  disabled?: boolean
  emptyMessage?: string
}) {
  const editable = !!onChange && !disabled
  const [focus, setFocus] = useState<Focus | null>(null)
  const [preview, setPreview] = useState<Focus | null>(null)
  const [filter, setFilter] = useState("")
  const target =
    targets.find((candidate) => candidate.key === addTarget) ?? targets[0]

  const rows = useMemo(() => targets.flatMap(targetRows), [targets])
  const visibleRows = useMemo(() => {
    const text = filter.trim().toLowerCase()
    if (!text) return rows
    return rows.filter((row) => {
      const [title, subtitle] = rowCopy(row.item)
      return (
        title.toLowerCase().includes(text) ||
        subtitle.toLowerCase().includes(text)
      )
    })
  }, [rows, filter])

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
  const shownTarget = shown
    ? targets.find((candidate) => candidate.key === shown.targetKey)
    : undefined
  const focusedId = focus ? `${focus.targetKey}|${itemId(focus.item)}` : null
  const unsupportedCount = rows.filter((row) => row.unsupported).length

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-3">
        {editable && target ? (
          <NodeInput
            target={target}
            presets={presets}
            contextPicker={contextPicker}
            onAdd={add}
            onPreview={setPreview}
          />
        ) : null}
        {unsupportedCount ? (
          <p
            role="alert"
            className="type-support flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {unsupportedCount === 1
              ? "One saved entry is unavailable for its resource. Remove it before saving."
              : `${unsupportedCount} saved entries are unavailable for their resources. Remove them before saving.`}
          </p>
        ) : null}
        <section aria-label="Permission entries" className="space-y-2">
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <h3 className="type-card-title">
              Entries{" "}
              <span className="type-meta text-muted-foreground">
                {rows.length}
              </span>
            </h3>
            {!showContexts && target && hasContextNames(target.context) ? (
              <span className="type-meta flex min-w-0 items-center gap-1.5 text-muted-foreground">
                on <ContextChips context={target.context} />
              </span>
            ) : null}
            {rows.length > 8 ? (
              <div className="relative ml-auto w-full sm:w-56">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Filter entries"
                  placeholder="Filter entries"
                  className="h-8 pl-8"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            ) : null}
          </div>
          {visibleRows.length ? (
            <RowList
              rows={visibleRows}
              focusedId={focusedId}
              showContexts={showContexts}
              editable={editable}
              onSelect={select}
              onRemove={remove}
            />
          ) : (
            <p className="type-support rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground">
              {rows.length ? "No entries match this filter." : emptyMessage}
            </p>
          )}
        </section>
      </div>
      <InfoSheet
        focus={shown}
        target={shownTarget ?? target}
        targets={targets}
        previewing={!!preview}
        showContexts={showContexts}
      />
    </div>
  )
})

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
      name: preset?.name ?? "Unknown preset",
      selections: preset?.selections ?? [],
    })
  }
  const nodes: Array<Row> = target.selections.map((selection) => {
    const expanded = tryExpandSelections([selection], scopeType, capabilities)
    const item: Item = { kind: "node", selection }
    return {
      id: `${target.key}|${itemId(item)}`,
      target,
      item,
      unsupported: !expanded,
      included: expanded
        ? expanded.length - (selection.kind === "permission" ? 1 : 0)
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
  if (item.kind === "preset") return [item.name, "Preset"]
  const option = permissionNodeOption(item.selection)
  return [option.node, option.label]
}

const RowList = memo(function RowList({
  rows,
  focusedId,
  showContexts,
  editable,
  onSelect,
  onRemove,
}: {
  rows: ReadonlyArray<Row>
  focusedId: string | null
  showContexts: boolean
  editable: boolean
  onSelect: (row: Row) => void
  onRemove: (row: Row) => void
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border">
      {rows.map((row) => (
        <EntryRow
          key={row.id}
          row={row}
          focused={row.id === focusedId}
          showContexts={showContexts}
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
  showContexts,
  editable,
  onSelect,
  onRemove,
}: {
  row: Row
  focused: boolean
  showContexts: boolean
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
      className="flex items-center gap-1 pr-1.5 transition-colors hover:bg-muted/40 data-[focused=true]:bg-muted/60"
    >
      <button
        type="button"
        aria-pressed={focused}
        onClick={() => onSelect(row)}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {item.kind === "preset" ? (
            <Layers className="size-4 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              {item.kind === "node" ? (
                <code className="type-code truncate text-foreground">
                  {title}
                </code>
              ) : (
                <span className="type-body truncate font-medium">{title}</span>
              )}
              {item.kind === "preset" ? (
                <Badge variant="secondary">
                  {item.builtin ? "Kiln preset" : "Preset"}
                </Badge>
              ) : null}
              {host ? <Badge variant="destructive">Host access</Badge> : null}
              {row.unsupported ? (
                <Badge variant="destructive">Unavailable here</Badge>
              ) : null}
            </span>
            {item.kind === "node" ? (
              <span className="type-meta block truncate text-muted-foreground">
                {subtitle}
              </span>
            ) : null}
          </span>
        </span>
        {showContexts ? <ContextChips context={row.target.context} /> : null}
        {row.included > 0 ? (
          <span className="type-meta shrink-0 text-muted-foreground tabular-nums">
            {item.kind === "preset"
              ? `${row.included} permission${row.included === 1 ? "" : "s"}`
              : `+${row.included} included`}
          </span>
        ) : null}
      </button>
      {editable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${title}`}
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
  contextPicker,
  onAdd,
  onPreview,
}: {
  target: PermissionTarget
  presets: boolean
  contextPicker?: ReactNode
  onAdd: (target: PermissionTarget, item: Item) => void
  onPreview: (focus: Focus | null) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState("")
  const anchorRef = useRef<HTMLDivElement>(null)
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

  const grouped = useMemo(() => {
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
    onPreview(null)
  }, [onPreview])
  function choose(entry: Suggestion) {
    if (entry.blocked) return
    onAdd(target, entry.item)
    setQuery("")
    inputRef.current?.focus()
  }

  const ready = !!access && !target.notice
  return (
    <Command
      shouldFilter={false}
      value={highlighted}
      onValueChange={preview}
      loop
      className="h-auto overflow-visible rounded-none! bg-transparent p-0"
    >
      <Popover
        open={open && ready}
        onOpenChange={(value) => (value ? setOpen(true) : close())}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <PopoverAnchor asChild>
            <div
              ref={anchorRef}
              className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input/90 bg-input/20 px-3 transition-[border-color,box-shadow] focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/35"
            >
              <Plus className="size-4 shrink-0 text-muted-foreground" />
              <CommandBareInput
                ref={inputRef}
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
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && open) {
                    event.preventDefault()
                    event.stopPropagation()
                    close()
                  } else if (!open && event.key === "ArrowDown") setOpen(true)
                }}
                className="type-input h-full min-w-0 flex-1 bg-transparent font-mono outline-hidden placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed"
              />
              <Kbd className="hidden sm:inline-flex">↵</Kbd>
            </div>
          </PopoverAnchor>
          {contextPicker}
        </div>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-(--radix-popover-trigger-width) min-w-[min(24rem,calc(100vw-2rem))] p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node))
              event.preventDefault()
          }}
        >
          <CommandList
            aria-label="Permission suggestions"
            className="max-h-80"
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
                    ? "Choose a Relay context to grant it."
                    : null}
                </>
              ) : (
                "No permissions match."
              )}
            </CommandEmpty>
            {grouped.map(([group, entries]) => (
              <CommandGroup key={group} heading={group}>
                {entries.map((entry) => (
                  <CommandItem
                    key={entry.value}
                    value={entry.value}
                    disabled={!!entry.blocked}
                    onSelect={() => choose(entry)}
                    className="gap-3"
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
        </PopoverContent>
      </Popover>
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

function InfoSheet({
  focus,
  target,
  targets,
  previewing,
  showContexts,
}: {
  focus: Focus | null
  target?: PermissionTarget
  targets: ReadonlyArray<PermissionTarget>
  previewing: boolean
  showContexts: boolean
}) {
  return (
    <aside
      aria-label="Permission details"
      aria-live="polite"
      className="h-fit min-w-0 rounded-xl border bg-muted/20 p-4 lg:sticky lg:top-0"
    >
      {focus && target ? (
        <ItemDetails
          item={focus.item}
          target={target}
          previewing={previewing}
          showContext={showContexts}
        />
      ) : (
        <EffectiveSummary targets={targets} />
      )}
    </aside>
  )
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
          <ContextChips context={target.context} />
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
  targets,
}: {
  targets: ReadonlyArray<PermissionTarget>
}) {
  const summaries = useMemo(
    () =>
      targets.flatMap((target) => {
        const scopeType = target.context.scope.resourceType
        const capabilities = target.access?.supportedCapabilities
        const supported = target.selections.filter(
          (selection) =>
            tryExpandSelections([selection], scopeType, capabilities) !== null
        )
        const permissions =
          tryExpandSelections(
            [...supported, ...linkedSelections(target)],
            scopeType,
            capabilities
          ) ?? []
        return permissions.length ? [{ target, permissions }] : []
      }),
    [targets]
  )
  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <p className="type-technical-label text-muted-foreground">
          Effective access
        </p>
        <p className="type-support text-muted-foreground">
          Select an entry to see what it allows. Use{" "}
          <code className="type-code text-foreground">*</code> or{" "}
          <code className="type-code text-foreground">instance.files.*</code> to
          include permissions Kiln adds later.
        </p>
      </header>
      {summaries.length ? (
        summaries.map(({ target, permissions }) => (
          <DetailSection
            key={target.key}
            title={
              summaries.length > 1 || hasContextNames(target.context)
                ? contextLabel(target.context)
                : "Permissions"
            }
            count={permissions.length}
          >
            <PermissionList keys={permissions} />
          </DetailSection>
        ))
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
function contextLabel(context: PermissionContext) {
  const relay = context.relayName ?? context.scope.relayId
  return context.scope.resourceType === "relay"
    ? `Relay ${relay}`
    : `${context.resourceName ?? context.scope.resourceId} on ${relay}`
}

export function ContextChips({ context }: { context: PermissionContext }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
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
