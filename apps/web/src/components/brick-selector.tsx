import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Brick } from "@workspace/contracts"
import { Result } from "effect"
import {
  BadgeCheck,
  BookOpen,
  Check,
  ExternalLink,
  FileCode2,
  Globe2,
  Library,
  LifeBuoy,
  LoaderCircle,
  LockKeyhole,
  PackagePlus,
  Search,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import { BrickIcon } from "@/components/brick-icon"
import { useKilnGitRepositorySlug } from "@/lib/git-repository"
import {
  brickCatalogDetailsQueryOptions,
  brickCatalogsQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { saveCustomBrick } from "@/server/bricks"
import {
  addBrickCatalog,
  deleteBrickCatalog,
  setBrickCatalogCommunity,
} from "@/server/brick-catalogs"

export type BrickSelection =
  | { kind: "catalog"; brick: Brick }
  | { kind: "custom"; source: string }

type BrickCategoryId = "all" | "minecraft" | "steam" | "other"
type BrickTabId = BrickCategoryId | "catalogs" | "custom"
type BrickSourceFilter = "all" | "verified" | "community"
type BrickSort = "featured" | "name-asc" | "name-desc"

const CATEGORIES: ReadonlyArray<{ id: BrickCategoryId; label: string }> = [
  { id: "all", label: "All" },
  { id: "minecraft", label: "Minecraft" },
  { id: "steam", label: "Steam" },
  { id: "other", label: "Other" },
]

const SOURCE_FILTERS: ReadonlyArray<{
  id: BrickSourceFilter
  label: string
}> = [
  { id: "all", label: "All Sources" },
  { id: "verified", label: "Verified" },
  { id: "community", label: "Community" },
]

const SORT_OPTIONS: ReadonlyArray<{ id: BrickSort; label: string }> = [
  { id: "featured", label: "Sort: Featured" },
  { id: "name-asc", label: "Sort: Name A–Z" },
  { id: "name-desc", label: "Sort: Name Z–A" },
]

const EMPTY_BRICKS: Array<Brick> = []

export function isVerifiedBrick(
  brick: Brick,
  gitRepositorySlug: string
): boolean {
  return Result.getOrElse(
    Result.try(() => {
      const url = new URL(brick.source)
      const [owner, repository, reference, ...path] = url.pathname
        .split("/")
        .filter(Boolean)
      return (
        url.hostname.toLowerCase() === "raw.githubusercontent.com" &&
        `${owner}/${repository}`.toLowerCase() ===
          gitRepositorySlug.toLowerCase() &&
        (reference === "main" || /^[a-f0-9]{40}$/u.test(reference ?? "")) &&
        path.join("/").startsWith("apps/bricks/")
      )
    }),
    () => false
  )
}

function brickCategory(brick: Brick): Exclude<BrickCategoryId, "all"> {
  const tags = new Set(
    (brick.metadata.tags ?? []).map((tag) => tag.toLowerCase())
  )
  if (
    tags.has("steam") ||
    brick.runtime.image.toLowerCase().includes("steam")
  ) {
    return "steam"
  }
  if (brick.metadata.game.trim().toLowerCase() === "minecraft") {
    return "minecraft"
  }
  return "other"
}

function brickSearchText(brick: Brick): string {
  return [
    brick.metadata.name,
    brick.metadata.game,
    brick.metadata.id,
    brick.metadata.author,
    brick.metadata.description,
    ...(brick.metadata.tags ?? []),
  ]
    .join(" ")
    .toLowerCase()
}

function formatGameLabel(brick: Brick): string {
  const tags = new Set(brick.metadata.tags ?? [])
  if (tags.has("java")) return `${brick.metadata.game} - Java`
  if (tags.has("bedrock")) return `${brick.metadata.game} - Bedrock`
  return brick.metadata.game
}

const PLATFORM_ARCHITECTURES = ["amd64", "arm64"] as const

const ArchitectureTag = React.memo(function ArchitectureTag({
  architecture,
  supported,
}: {
  architecture: string
  supported: boolean
}) {
  return (
    <span
      className={cn(
        "type-meta inline-flex h-5 items-center gap-0.5 rounded-md border px-1 font-mono font-semibold",
        supported
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      )}
    >
      {supported ? (
        <Check className="size-2.5 shrink-0" />
      ) : (
        <X className="size-2.5 shrink-0" />
      )}
      {architecture}
    </span>
  )
})

function normalizeArchitecture(architecture: string): string {
  switch (architecture.trim().toLowerCase()) {
    case "x64":
    case "x86-64":
    case "x86_64":
      return "amd64"
    case "aarch64":
      return "arm64"
    default:
      return architecture.trim().toLowerCase()
  }
}

function sourceLabel(brick: Brick, gitRepositorySlug: string): string {
  return isVerifiedBrick(brick, gitRepositorySlug) ? "Verified" : "Community"
}

function filterAndSortBricks(
  bricks: Array<Brick>,
  {
    category,
    gitRepositorySlug,
    query,
    sort,
    sourceFilter,
  }: {
    category: BrickCategoryId
    gitRepositorySlug: string
    query: string
    sort: BrickSort
    sourceFilter: BrickSourceFilter
  }
): Array<Brick> {
  const normalized = query.trim().toLowerCase()
  const searchTextBySource = new Map<string, string>()
  for (const brick of bricks) {
    searchTextBySource.set(brick.source, brickSearchText(brick))
  }

  const filtered = bricks.filter((brick) => {
    if (category !== "all" && brickCategory(brick) !== category) return false
    if (
      sourceFilter === "verified" &&
      !isVerifiedBrick(brick, gitRepositorySlug)
    ) {
      return false
    }
    if (
      sourceFilter === "community" &&
      isVerifiedBrick(brick, gitRepositorySlug)
    ) {
      return false
    }
    if (!normalized) return true
    const text = searchTextBySource.get(brick.source) ?? ""
    return text.includes(normalized)
  })

  return filtered.sort((a, b) => {
    if (sort === "name-asc") {
      return a.metadata.name.localeCompare(b.metadata.name)
    }
    if (sort === "name-desc") {
      return b.metadata.name.localeCompare(a.metadata.name)
    }
    const verifiedDelta =
      Number(isVerifiedBrick(b, gitRepositorySlug)) -
      Number(isVerifiedBrick(a, gitRepositorySlug))
    if (verifiedDelta !== 0) return verifiedDelta
    return a.metadata.name.localeCompare(b.metadata.name)
  })
}

function filterAndSortCustomBricks(
  bricks: Array<Brick>,
  query: string
): Array<Brick> {
  const normalized = query.trim().toLowerCase()
  return normalized
    ? bricks.reduce<Array<Brick>>((matches, brick) => {
        if (brickSearchText(brick).includes(normalized)) matches.push(brick)
        return matches
      }, [])
    : [...bricks]
}

const BrickTabSidebar = React.memo(function BrickTabSidebar({
  canAddCustomBrick,
  disabled,
  tab,
  onTabChange,
}: {
  canAddCustomBrick: boolean
  disabled: boolean
  tab: BrickTabId
  onTabChange: (tab: BrickTabId) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col border-b border-border/60 max-md:min-h-max md:border-r md:border-b-0">
      <p className="type-technical-label px-3 pt-3 pb-2 text-muted-foreground">
        Categories
      </p>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto md:pb-3">
        {CATEGORIES.map((item) => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onTabChange(item.id)}
              className={cn(
                "relative shrink-0 rounded-md px-2.5 py-2 text-left text-xs transition-colors duration-150",
                active
                  ? "bg-primary/12 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
                disabled && "pointer-events-none opacity-50"
              )}
            >
              {active ? (
                <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary md:left-0" />
              ) : null}
              <span className={cn(active && "pl-1.5")}>{item.label}</span>
            </button>
          )
        })}
      </nav>
      <div className="mt-auto space-y-1 border-t border-border/60 p-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onTabChange("catalogs")}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors duration-150",
            tab === "catalogs"
              ? "bg-primary/12 font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
            disabled && "pointer-events-none opacity-50"
          )}
        >
          <Library className="size-3.5 shrink-0 text-primary" />
          Catalogs
        </button>
        {canAddCustomBrick ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onTabChange("custom")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors duration-150",
              tab === "custom"
                ? "bg-primary/12 font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
              disabled && "pointer-events-none opacity-50"
            )}
          >
            <PackagePlus className="size-3.5 shrink-0 text-primary" />
            Custom Brick
          </button>
        ) : null}
      </div>
    </aside>
  )
})

function useSaveCustomBrick(
  relayId: string,
  onSelectionChange: (selection: BrickSelection | null) => void
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (source: string) =>
      saveCustomBrick({ data: { relayId, source } }),
    onSuccess: async ({ brick, brickIdWasTruncated }) => {
      onSelectionChange({ kind: "catalog", brick })
      showToast({
        type: brickIdWasTruncated ? "warning" : "success",
        message: brickIdWasTruncated
          ? `${brick.metadata.name} saved with a shortened id`
          : `${brick.metadata.name} saved`,
        description: brickIdWasTruncated
          ? `Its Brick id was shortened to “${brick.metadata.id}” to fit the 20-character limit.`
          : "This custom Brick is now available in your catalog.",
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.brickIcons }),
      ])
    },
    onError: (cause) => {
      showToast({
        type: "error",
        message: "Could not save custom Brick",
        description:
          cause instanceof Error ? cause.message : "Check the recipe URL.",
      })
    },
  })
}

export const BrickCatalogBrowser = React.memo(function BrickCatalogBrowser({
  relayId,
  bricks,
  canAddCustomBrick,
  customBricks = EMPTY_BRICKS,
  selection,
  onSelectionChange,
  disabled = false,
  className,
  configuration,
  emptyMessage = "No bricks match these filters.",
}: {
  relayId: string
  bricks: Array<Brick>
  canAddCustomBrick: boolean
  customBricks?: Array<Brick>
  selection: BrickSelection | null
  onSelectionChange: (selection: BrickSelection | null) => void
  disabled?: boolean
  className?: string
  configuration?: React.ReactNode
  emptyMessage?: string
}) {
  const gitRepositorySlug = useKilnGitRepositorySlug()
  const customBrickSources = React.useMemo(
    () => new Set(customBricks.map((brick) => brick.source)),
    [customBricks]
  )
  const [tab, setTab] = React.useState<BrickTabId>(() =>
    selection?.kind === "custom" ||
    (selection?.kind === "catalog" &&
      customBrickSources.has(selection.brick.source))
      ? "custom"
      : "all"
  )
  const [query, setQuery] = React.useState("")
  const [sourceFilter, setSourceFilter] =
    React.useState<BrickSourceFilter>("all")
  const [sort, setSort] = React.useState<BrickSort>("featured")

  const catalogBricks = bricks.length > 0 ? bricks : EMPTY_BRICKS
  const visibleBricks = React.useMemo(() => {
    if (tab === "catalogs") return EMPTY_BRICKS
    if (tab === "custom") {
      return filterAndSortCustomBricks(customBricks, query)
    }
    return filterAndSortBricks(catalogBricks, {
      category: tab,
      gitRepositorySlug,
      query,
      sort,
      sourceFilter,
    })
  }, [
    catalogBricks,
    customBricks,
    gitRepositorySlug,
    query,
    sort,
    sourceFilter,
    tab,
  ])

  const saveMutation = useSaveCustomBrick(relayId, onSelectionChange)

  const selectedCatalog = selection?.kind === "catalog" ? selection.brick : null
  const customOpen = tab === "custom"
  const selectTab = React.useCallback(
    (nextTab: BrickTabId) => {
      if (nextTab === "catalogs") {
        setTab(nextTab)
        onSelectionChange(null)
        return
      }
      if (nextTab === "custom" && tab === "custom") return
      setTab(nextTab)
      if (nextTab === "custom") {
        const next = customBricks[0]
        onSelectionChange(
          next
            ? { kind: "catalog", brick: next }
            : {
                kind: "custom",
                source: selection?.kind === "custom" ? selection.source : "",
              }
        )
        return
      }

      const next =
        filterAndSortBricks(catalogBricks, {
          category: nextTab,
          gitRepositorySlug,
          query,
          sort,
          sourceFilter,
        })[0] ?? catalogBricks[0]
      onSelectionChange(next ? { kind: "catalog", brick: next } : null)
    },
    [
      catalogBricks,
      customBricks,
      gitRepositorySlug,
      onSelectionChange,
      query,
      selection,
      sort,
      sourceFilter,
      tab,
    ]
  )

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-background/35 max-md:grid-rows-[max-content_minmax(32rem,auto)] max-md:overflow-y-auto md:grid-cols-[9.5rem_minmax(0,1fr)_18.5rem] lg:grid-cols-[10.5rem_minmax(0,1fr)_20rem]",
        className
      )}
    >
      <BrickTabSidebar
        canAddCustomBrick={canAddCustomBrick}
        disabled={disabled}
        tab={tab}
        onTabChange={selectTab}
      />

      {tab === "catalogs" ? (
        <BrickCatalogManager disabled={disabled} />
      ) : (
        <>
          <section className="flex min-h-80 min-w-0 flex-col border-b border-border/60 md:min-h-0 md:border-r md:border-b-0">
            <div className="space-y-2 border-b border-border/60 p-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  disabled={disabled}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    customOpen ? "Search custom bricks…" : "Search bricks…"
                  }
                  className="h-9 pl-8 text-base md:text-sm"
                />
              </label>
              {customOpen ? (
                <div className="flex h-8 items-center justify-between gap-2">
                  <span className="type-technical-label text-muted-foreground">
                    {customBricks.length} saved
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={disabled || saveMutation.isPending}
                    onClick={() =>
                      onSelectionChange({ kind: "custom", source: "" })
                    }
                  >
                    <PackagePlus />
                    Add Brick
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={sourceFilter}
                    disabled={disabled || customOpen}
                    onValueChange={(value) => {
                      const next = SOURCE_FILTERS.find(
                        (option) => option.id === value
                      )
                      if (next) setSourceFilter(next.id)
                    }}
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs [&_[data-slot=select-value]]:whitespace-nowrap"
                      aria-label="Filter by source"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_FILTERS.map((option) => (
                        <SelectItem
                          key={option.id}
                          value={option.id}
                          className="whitespace-nowrap"
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={sort}
                    disabled={disabled || customOpen}
                    onValueChange={(value) => {
                      const next = SORT_OPTIONS.find(
                        (option) => option.id === value
                      )
                      if (next) setSort(next.id)
                    }}
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs [&_[data-slot=select-value]]:whitespace-nowrap"
                      aria-label="Sort bricks"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((option) => (
                        <SelectItem
                          key={option.id}
                          value={option.id}
                          className="whitespace-nowrap"
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {visibleBricks.length === 0 ? (
                <div className="grid h-full place-items-center px-4 py-8 text-center">
                  <div className="max-w-xs">
                    {customOpen ? (
                      <PackagePlus className="mx-auto size-5 text-primary" />
                    ) : null}
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {customOpen
                        ? query.trim()
                          ? "No custom Bricks match your search."
                          : "Add a recipe URL to save your first custom Brick."
                        : emptyMessage}
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {visibleBricks.map((brick) => {
                    const selected = selectedCatalog?.source === brick.source
                    const custom = customBrickSources.has(brick.source)
                    const verified = isVerifiedBrick(brick, gitRepositorySlug)
                    return (
                      <li key={brick.source}>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            onSelectionChange({ kind: "catalog", brick })
                          }
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150",
                            selected
                              ? "bg-primary/14 ring-1 ring-primary/35"
                              : "hover:bg-accent/55",
                            disabled && "pointer-events-none opacity-50"
                          )}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/70 text-muted-foreground">
                            <BrickIcon
                              id={brick.metadata.id}
                              color={brick.metadata.color}
                              iconSvg={brick.iconSvg}
                              className="size-4"
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold tracking-tight">
                              {brick.metadata.name}
                            </span>
                            <span className="type-support mt-0.5 block truncate text-muted-foreground">
                              {custom
                                ? "Custom"
                                : sourceLabel(brick, gitRepositorySlug)}{" "}
                              · {formatGameLabel(brick)}
                            </span>
                          </span>
                          {custom ? (
                            <Badge
                              variant="outline"
                              className="type-meta h-6 shrink-0 px-1.5 font-mono text-muted-foreground"
                            >
                              Custom
                            </Badge>
                          ) : verified ? (
                            <Badge
                              variant="outline"
                              className="type-meta h-6 shrink-0 gap-1 border-primary/35 bg-primary/10 px-1.5 font-mono text-primary"
                            >
                              <BadgeCheck className="size-3" />
                              Verified
                            </Badge>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>

          <BrickDetailsPanel
            selection={selection}
            disabled={disabled}
            gitRepositorySlug={gitRepositorySlug}
            customBrickSources={customBrickSources}
            onSelectionChange={onSelectionChange}
            onSaveCustomBrick={(source) => saveMutation.mutate(source)}
            saveCustomBrickDisabled={!relayId}
            savingCustomBrick={saveMutation.isPending}
            configuration={configuration}
          />
        </>
      )}
    </div>
  )
})

const BrickCatalogManager = React.memo(function BrickCatalogManager({
  disabled,
}: {
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const catalogsQuery = useQuery(brickCatalogsQueryOptions())
  const [selectedId, setSelectedId] = React.useState("default")
  const [deleteCandidateId, setDeleteCandidateId] = React.useState<
    string | null
  >(null)
  const [source, setSource] = React.useState("")
  const detailsQuery = useQuery({
    ...brickCatalogDetailsQueryOptions(selectedId),
    enabled: selectedId.length > 0,
  })
  const addMutation = useMutation({
    mutationFn: (nextSource: string) =>
      addBrickCatalog({ data: { source: nextSource } }),
    onSuccess: async (catalog) => {
      setSource("")
      setSelectedId(catalog.id)
      const truncatedCount = catalog.truncatedBrickIds.length
      const truncatedPreview = catalog.truncatedBrickIds.slice(0, 3).join(", ")
      const remainingTruncated = truncatedCount - 3
      showToast({
        type: truncatedCount > 0 ? "warning" : "success",
        message:
          truncatedCount > 0
            ? "Catalog added with shortened Brick ids"
            : "Catalog added",
        description:
          truncatedCount > 0
            ? `${truncatedCount} Brick id${truncatedCount === 1 ? " was" : "s were"} shortened to fit the 20-character limit: ${truncatedPreview}${remainingTruncated > 0 ? `, and ${remainingTruncated} more` : ""}.`
            : `${catalog.brickCount} Brick${catalog.brickCount === 1 ? "" : "s"} saved in this snapshot.`,
      })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.brickCatalogs.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.brickIcons }),
      ])
    },
    onError: (cause) =>
      showToast({
        type: "error",
        message: "Could not add catalog",
        description:
          cause instanceof Error ? cause.message : "Check the catalog source.",
      }),
  })
  const visibilityMutation = useMutation({
    mutationFn: (input: { catalogId: string; community: boolean }) =>
      setBrickCatalogCommunity({ data: input }),
    onSuccess: async (catalog) => {
      showToast({
        type: "success",
        message:
          catalog.visibility === "community"
            ? "Catalog published"
            : "Catalog unpublished",
        description:
          catalog.visibility === "community"
            ? "Every account can now use this immutable snapshot."
            : "Only its owner can use this catalog now.",
      })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.brickCatalogs.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.brickIcons }),
      ])
    },
    onError: catalogMutationError,
  })
  const deleteMutation = useMutation({
    mutationFn: (catalogId: string) =>
      deleteBrickCatalog({ data: { catalogId } }),
    onSuccess: async () => {
      setDeleteCandidateId(null)
      setSelectedId("default")
      showToast({ type: "success", message: "Catalog deleted" })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.brickCatalogs.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.brickIcons }),
      ])
    },
    onError: catalogMutationError,
  })
  const catalogs = catalogsQuery.data?.catalogs ?? []
  const selected = catalogs.find((catalog) => catalog.id === selectedId)
  const deleteCandidate = catalogs.find(
    (catalog) => catalog.id === deleteCandidateId
  )
  const pending =
    disabled ||
    addMutation.isPending ||
    visibilityMutation.isPending ||
    deleteMutation.isPending

  return (
    <section className="grid min-h-[32rem] min-w-0 grid-cols-[minmax(0,1fr)] md:col-span-2 md:min-h-0 md:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-h-0 min-w-0 flex-col border-b border-border/60 md:border-r md:border-b-0">
        {catalogsQuery.data?.canAddCatalog ? (
          <form
            className="border-b border-border/60 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              const value = source.trim()
              if (value) addMutation.mutate(value)
            }}
          >
            <p className="type-technical-label text-muted-foreground">
              Catalog sources
            </p>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                value={source}
                disabled={pending}
                onChange={(event) => setSource(event.target.value)}
                placeholder="owner/repo or https://…/catalog.yml"
                aria-label="Catalog URL or repository"
                className="h-9 min-w-0 flex-1 text-base md:text-sm"
              />
              <Button
                type="submit"
                size="sm"
                className="h-9 shrink-0"
                disabled={pending || source.trim().length === 0}
              >
                {addMutation.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <PackagePlus />
                )}
                Add
              </Button>
            </div>
            <p className="type-support mt-2 text-muted-foreground">
              Example catalog can be found{" "}
              <a
                href="https://github.com/kiln-site/kiln/blob/main/apps/bricks/catalog.yml"
                target="_blank"
                rel="noreferrer"
                aria-label="View the example catalog on GitHub"
                className="text-foreground underline underline-offset-2 hover:text-primary"
              >
                here
              </a>
              .
            </p>
          </form>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {catalogsQuery.isPending ? (
            <div className="grid h-full place-items-center">
              <LoaderCircle className="size-5 animate-spin text-primary" />
            </div>
          ) : catalogs.length === 0 ? (
            <div className="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">
              No catalogs are available.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {catalogs.map((catalog) => (
                <li key={catalog.id}>
                  <div
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 transition-colors duration-150",
                      selectedId === catalog.id
                        ? "bg-primary/14 ring-1 ring-primary/35"
                        : "hover:bg-accent/55",
                      disabled && "pointer-events-none opacity-50"
                    )}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setSelectedId(catalog.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/70 text-primary">
                        {catalog.visibility === "community" ? (
                          <Globe2 className="size-4" />
                        ) : catalog.isDefault ? (
                          <Library className="size-4" />
                        ) : (
                          <LockKeyhole className="size-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold tracking-tight">
                          <span className="truncate">
                            {catalogDisplayName(catalog)}
                          </span>
                          <CatalogTrustBadge catalog={catalog} />
                        </span>
                        {catalog.author ? (
                          <span className="type-support mt-0.5 block truncate text-muted-foreground">
                            By {catalog.author}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {catalog.statusError ? (
                      <Badge variant="destructive">Unavailable</Badge>
                    ) : null}
                    {catalog.docs || catalog.support ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {catalog.docs ? (
                          <a
                            href={catalog.docs}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${catalogDisplayName(catalog)} documentation`}
                            className="type-control-sm inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-muted/25 px-2 transition-colors hover:border-primary/35 hover:bg-primary/8 hover:text-primary"
                          >
                            <BookOpen className="size-3" />
                            Docs
                          </a>
                        ) : null}
                        {catalog.support ? (
                          <a
                            href={catalog.support}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${catalogDisplayName(catalog)} support`}
                            className="type-control-sm inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-muted/25 px-2 transition-colors hover:border-primary/35 hover:bg-primary/8 hover:text-primary"
                          >
                            <LifeBuoy className="size-3" />
                            Support
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <aside className="flex min-h-0 flex-col">
        {!selected ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-xs text-muted-foreground">
            Select a catalog to inspect its snapshot.
          </div>
        ) : (
          <>
            <div className="border-b border-border/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {selected.isDefault ? null : (
                    <p className="type-technical-label text-muted-foreground">
                      {catalogVisibilityLabel(selected.visibility)}
                    </p>
                  )}
                  <div
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      !selected.isDefault && "mt-1.5"
                    )}
                  >
                    <h3 className="min-w-0 truncate font-heading text-lg font-semibold tracking-[-0.025em] sm:text-xl">
                      {catalogDisplayName(selected)}
                    </h3>
                    <CatalogTrustBadge catalog={selected} />
                  </div>
                  {catalogsQuery.data?.isPlatformAdmin &&
                  selected.ownerUserId ? (
                    <p className="type-support mt-1 truncate text-muted-foreground">
                      Owner:{" "}
                      {selected.ownerEmail ??
                        selected.ownerName ??
                        selected.ownerUserId}
                    </p>
                  ) : null}
                </div>
              </div>
              {selected.revisionUrl && selected.revisionSha ? (
                <a
                  href={selected.revisionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 flex items-center justify-between gap-3 rounded-md border border-primary/25 bg-primary/7 px-2.5 py-2 text-xs hover:bg-primary/10"
                >
                  <span>
                    <span className="block font-medium">
                      {selected.visibility === "community"
                        ? "Published snapshot"
                        : "Source snapshot"}
                    </span>
                    <span className="type-code text-muted-foreground">
                      commit {selected.revisionSha.slice(0, 10)}
                    </span>
                  </span>
                  <ExternalLink className="size-3.5 text-primary" />
                </a>
              ) : selected.snapshotSha256 ? (
                <div className="mt-3 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
                  <span className="block text-xs font-medium">
                    Saved snapshot
                  </span>
                  <span className="type-code text-muted-foreground">
                    sha256:{selected.snapshotSha256.slice(0, 12)}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {detailsQuery.isPending ? (
                <div className="grid h-full place-items-center">
                  <LoaderCircle className="size-4 animate-spin text-primary" />
                </div>
              ) : detailsQuery.isError ? (
                <p className="text-xs text-destructive">
                  {detailsQuery.error instanceof Error
                    ? detailsQuery.error.message
                    : "Could not load this catalog snapshot."}
                </p>
              ) : detailsQuery.data?.bricks.length ? (
                <ul className="space-y-1">
                  {detailsQuery.data.bricks.map((brick) => (
                    <li
                      key={brick.source}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2"
                    >
                      <BrickIcon
                        id={brick.metadata.id}
                        color={brick.metadata.color}
                        iconSvg={brick.iconSvg}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {brick.metadata.name}
                      </span>
                      <span className="type-meta font-mono text-muted-foreground">
                        {brick.metadata.id}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {selected.statusError ?? "This snapshot contains no Bricks."}
                </p>
              )}
            </div>

            {!selected.isDefault ? (
              <div className="grid grid-cols-2 gap-2 border-t border-border/60 p-3">
                {catalogsQuery.data?.isPlatformAdmin ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      visibilityMutation.mutate({
                        catalogId: selected.id,
                        community: selected.visibility !== "community",
                      })
                    }
                  >
                    <Globe2 />
                    {selected.visibility === "community"
                      ? "Unpublish"
                      : "Publish"}
                  </Button>
                ) : (
                  <span />
                )}
                {catalogsQuery.data?.isPlatformAdmin ||
                (selected.ownerUserId === catalogsQuery.data?.userId &&
                  selected.visibility !== "community") ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => setDeleteCandidateId(selected.id)}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </aside>
      <Dialog
        open={deleteCandidate !== undefined}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteCandidateId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete catalog?</DialogTitle>
            <DialogDescription>
              {deleteCandidate
                ? `${catalogDisplayName(deleteCandidate)} will be removed from this Hearth account.`
                : "This catalog will be removed from this Hearth account."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteCandidateId(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!deleteCandidate || deleteMutation.isPending}
              onClick={() => {
                if (deleteCandidate) deleteMutation.mutate(deleteCandidate.id)
              }}
            >
              {deleteMutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
})

function catalogMutationError(cause: unknown): void {
  showToast({
    type: "error",
    message: "Could not update catalog",
    description:
      cause instanceof Error ? cause.message : "Try this action again.",
  })
}

export function catalogDisplayName(catalog: {
  isDefault: boolean
  name?: string | null
  source: string
}): string {
  if (catalog.name) return catalog.name
  if (catalog.isDefault) return "Kiln"
  return catalogSourceLabel(catalog.source)
}

function catalogSourceLabel(source: string): string {
  return Result.getOrElse(
    Result.try(() => {
      const url = new URL(source)
      const hostname = url.hostname.toLowerCase()
      const segments = url.pathname.split("/").filter(Boolean)
      if (
        (hostname === "github.com" ||
          hostname === "raw.githubusercontent.com") &&
        segments[0] &&
        segments[1]
      ) {
        return `${segments[0]}/${segments[1].replace(/\.git$/u, "")}`
      }
      return hostname
    }),
    () => source
  )
}

function CatalogTrustBadge({
  catalog,
}: {
  catalog: {
    isDefault: boolean
    visibility: "community" | "default" | "personal"
  }
}) {
  if (catalog.isDefault) {
    return (
      <Badge
        variant="outline"
        className="type-meta h-6 shrink-0 gap-1 border-primary/35 bg-primary/10 px-1.5 text-primary"
      >
        <BadgeCheck className="size-3" />
        Verified
      </Badge>
    )
  }
  if (catalog.visibility === "community") {
    return (
      <Badge variant="outline" className="type-meta h-6 shrink-0 px-1.5">
        Community
      </Badge>
    )
  }
  return null
}

function catalogVisibilityLabel(
  visibility: "community" | "default" | "personal"
): string {
  if (visibility === "community") return "Community"
  if (visibility === "default") return "Default"
  return "Personal"
}

const BrickDetailsPanel = React.memo(function BrickDetailsPanel({
  selection,
  disabled,
  gitRepositorySlug,
  customBrickSources,
  onSelectionChange,
  onSaveCustomBrick,
  saveCustomBrickDisabled,
  savingCustomBrick,
  configuration,
}: {
  selection: BrickSelection | null
  disabled: boolean
  gitRepositorySlug: string
  customBrickSources: ReadonlySet<string>
  onSelectionChange: (selection: BrickSelection | null) => void
  onSaveCustomBrick: (source: string) => void
  saveCustomBrickDisabled: boolean
  savingCustomBrick: boolean
  configuration?: React.ReactNode
}) {
  if (selection?.kind === "custom") {
    return (
      <aside className="flex min-h-96 flex-col md:min-h-0">
        <form
          className="min-h-0 flex-1 overflow-y-auto p-4 pr-11"
          onSubmit={(event) => {
            event.preventDefault()
            const source = selection.source.trim()
            if (source) onSaveCustomBrick(source)
          }}
        >
          <p className="type-technical-label text-muted-foreground">
            Custom recipe
          </p>
          <h3 className="mt-2 font-heading text-lg font-semibold tracking-[-0.03em]">
            Bring your own Brick
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Point Kiln at any HTTPS recipe. We’ll validate it on a Relay and
            keep it in your custom catalog.
          </p>
          <label className="mt-4 block space-y-1.5 text-xs font-medium text-muted-foreground">
            <span>Recipe URL</span>
            <Input
              type="url"
              value={selection.source}
              disabled={disabled}
              onChange={(event) =>
                onSelectionChange({
                  kind: "custom",
                  source: event.target.value,
                })
              }
              placeholder="https://example.com/my-brick.yml"
              required
            />
          </label>
          <Button
            type="submit"
            size="sm"
            className="mt-3 w-full"
            disabled={
              disabled ||
              saveCustomBrickDisabled ||
              savingCustomBrick ||
              selection.source.trim().length === 0
            }
          >
            {savingCustomBrick ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <PackagePlus />
            )}
            Save Brick
          </Button>
        </form>
        {configuration ? (
          <div className="shrink-0 border-t border-border/60 p-4">
            {configuration}
          </div>
        ) : null}
      </aside>
    )
  }

  if (!selection) {
    return (
      <aside className="flex min-h-96 flex-col md:min-h-0">
        <div className="grid min-h-48 flex-1 place-items-center p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Select a Brick to inspect its details.
          </p>
        </div>
        {configuration ? (
          <div className="shrink-0 border-t border-border/60 p-4">
            {configuration}
          </div>
        ) : null}
      </aside>
    )
  }

  const brick = selection.brick
  const custom = customBrickSources.has(brick.source)
  const verified = isVerifiedBrick(brick, gitRepositorySlug)
  const supportedArchitectures = new Set(
    (brick.constraints.architectures ?? PLATFORM_ARCHITECTURES).map(
      normalizeArchitecture
    )
  )
  const tags = brick.metadata.tags ?? []

  return (
    <aside className="flex min-h-96 flex-col md:min-h-0">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pr-11">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/70 text-muted-foreground">
            <BrickIcon
              id={brick.metadata.id}
              color={brick.metadata.color}
              iconSvg={brick.iconSvg}
              className="size-5"
            />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate font-heading text-lg font-semibold tracking-[-0.03em]">
                {brick.metadata.name}
              </h3>
              {custom ? (
                <Badge
                  variant="outline"
                  className="type-meta h-6 px-1.5 text-muted-foreground"
                >
                  Custom
                </Badge>
              ) : verified ? (
                <Badge
                  variant="outline"
                  className="type-meta h-6 gap-1 border-primary/35 bg-primary/10 px-1.5 text-primary"
                >
                  <BadgeCheck className="size-3" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="type-meta h-6 px-1.5">
                  Community
                </Badge>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {PLATFORM_ARCHITECTURES.map((architecture) => (
                <ArchitectureTag
                  key={architecture}
                  architecture={architecture}
                  supported={supportedArchitectures.has(architecture)}
                />
              ))}
            </div>
          </div>
        </div>

        <p className="type-support mt-4 text-foreground">
          {brick.metadata.description}
        </p>

        {tags.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="type-meta h-6 px-1.5 font-mono text-muted-foreground"
              >
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={brick.source} target="_blank" rel="noreferrer">
              <FileCode2 />
              View raw Brick
            </a>
          </Button>
          {brick.metadata.documentation ? (
            <Button asChild size="sm" variant="ghost">
              <a
                href={brick.metadata.documentation}
                target="_blank"
                rel="noreferrer"
              >
                <BookOpen />
                Docs
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      {configuration ? (
        <div className="shrink-0 border-t border-border/60 p-4">
          {configuration}
        </div>
      ) : null}
    </aside>
  )
})

export const BrickSelectDialog = React.memo(function BrickSelectDialog({
  open,
  onOpenChange,
  relayId,
  bricks,
  canAddCustomBrick,
  customBricks = EMPTY_BRICKS,
  initial,
  title = "Select Brick",
  description = "Browse or search bricks from the catalog.",
  confirmLabel = "Select Brick",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  relayId: string
  bricks: Array<Brick>
  canAddCustomBrick: boolean
  customBricks?: Array<Brick>
  initial: BrickSelection | null
  title?: string
  description?: string
  confirmLabel?: string
  onConfirm: (selection: BrickSelection) => void
}) {
  const [selection, setSelection] = React.useState<BrickSelection | null>(
    initial
  )

  React.useEffect(() => {
    if (open) setSelection(initial)
  }, [initial, open])

  const canConfirm = selection?.kind === "catalog"
  const actions = React.useMemo(
    () => (
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!canConfirm || !selection}
          onClick={() => {
            if (!selection || !canConfirm) return
            onConfirm(selection)
            onOpenChange(false)
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    ),
    [canConfirm, confirmLabel, onConfirm, onOpenChange, selection]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(36rem,calc(100dvh-2rem))] max-h-none gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)] xl:max-w-5xl">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <BrickCatalogBrowser
          relayId={relayId}
          bricks={bricks}
          canAddCustomBrick={canAddCustomBrick}
          customBricks={customBricks}
          selection={selection}
          onSelectionChange={setSelection}
          className="h-full rounded-none border-0 bg-transparent"
          emptyMessage={
            bricks.length === 0 ? description : "No bricks match these filters."
          }
          configuration={actions}
        />
      </DialogContent>
    </Dialog>
  )
})
