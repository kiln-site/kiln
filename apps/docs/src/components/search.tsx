import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { CornerDownLeft, FileText, Hash, Search } from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
import { cn } from "@workspace/ui/lib/utils"

import {
  type IndexedEntry,
  type SearchResult,
  indexEntries,
  search,
} from "~/lib/search"
import { sections } from "~/lib/pages"

// The search index is its own chunk, fetched the first time search opens or
// its button is hovered, so pages don't pay for it.
let indexPromise: Promise<Array<IndexedEntry>> | null = null
export function preloadSearchIndex(): Promise<Array<IndexedEntry>> {
  indexPromise ??= import("virtual:docs/search").then((module) =>
    indexEntries(module.default)
  )
  return indexPromise
}

const SearchContext = React.createContext<(() => void) | null>(null)

// Opens search from anywhere: ⌘K, Ctrl+K, or "/" outside a text field.
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const show = React.useCallback(() => setOpen(true), [])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault()
        setOpen((current) => !current)
        return
      }
      if (event.key === "/" && !isEditable(event.target)) {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <SearchContext.Provider value={show}>
      {children}
      <SearchDialog open={open} onOpenChange={setOpen} />
    </SearchContext.Provider>
  )
}

export function useOpenSearch(): () => void {
  const open = React.useContext(SearchContext)
  if (!open) throw new Error("useOpenSearch needs a SearchProvider")
  return open
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  )
}

function SearchDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [index, setIndex] = React.useState<Array<IndexedEntry> | null>(null)
  const [query, setQuery] = React.useState("")
  const deferredQuery = React.useDeferredValue(query)
  const navigate = useNavigate()

  React.useEffect(() => {
    if (!open || index) return
    let cancelled = false
    void preloadSearchIndex().then((loaded) => {
      if (!cancelled) setIndex(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [index, open])

  const results = React.useMemo(
    () => (index ? search(index, deferredQuery) : []),
    [deferredQuery, index]
  )
  const groups = React.useMemo(() => groupByPage(results), [results])

  const go = (path: string, anchor: string) => {
    onOpenChange(false)
    setQuery("")
    void navigate({
      to: "/$",
      params: { _splat: path.replace(/^\//, "") },
      hash: anchor || undefined,
    })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search the docs"
      description="Search every page and heading in Kiln's docs."
      // A column of fixed height: the field and the key hints stay put and
      // only the results scroll.
      className="flex h-[min(36rem,76dvh)] flex-col overflow-hidden sm:max-w-2xl"
    >
      <Command shouldFilter={false} loop className="min-h-0 flex-1">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search the docs"
          className="text-base sm:text-[0.9375rem]"
        />
        <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {query.trim() ? (
            <>
              <CommandEmpty>
                {index ? (
                  <>
                    No results for “{query.trim()}”.
                    <span className="mt-1 block text-xs">
                      Try fewer or different words.
                    </span>
                  </>
                ) : (
                  "Loading the search index…"
                )}
              </CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group.path} heading={group.title}>
                  {group.results.map((result) => (
                    <ResultItem
                      key={`${result.entry.path}#${result.entry.anchor}`}
                      result={result}
                      onSelect={() =>
                        go(result.entry.path, result.entry.anchor)
                      }
                    />
                  ))}
                </CommandGroup>
              ))}
            </>
          ) : (
            <Suggestions onSelect={(path) => go(path, "")} />
          )}
        </CommandList>
        <div className="type-meta hidden items-center gap-4 border-t border-border px-4 py-2.5 text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5">
            <Key>↑</Key>
            <Key>↓</Key>
            to move
          </span>
          <span className="flex items-center gap-1.5">
            <Key>
              <CornerDownLeft className="size-3" />
            </Key>
            to open
          </span>
          <span className="flex items-center gap-1.5">
            <Key>esc</Key>
            to close
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}

function ResultItem({
  onSelect,
  result,
}: {
  onSelect: () => void
  result: SearchResult
}) {
  const { entry, snippet } = result
  const isPage = entry.anchor === ""
  return (
    <CommandItem
      value={`${entry.path}#${entry.anchor}`}
      onSelect={onSelect}
      className="items-start gap-3 px-3 py-2.5 [&>svg:last-child]:hidden"
    >
      {isPage ? (
        <FileText className="mt-0.5 text-muted-foreground" />
      ) : (
        <Hash className="mt-0.5 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">
          {isPage ? entry.title : entry.heading}
        </span>
        {snippet.length > 0 ? (
          <span className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted-foreground">
            {snippet.map((part, index) =>
              part.match ? (
                <mark
                  key={index}
                  className="bg-transparent font-medium text-primary-ink"
                >
                  {part.text}
                </mark>
              ) : (
                <React.Fragment key={index}>{part.text}</React.Fragment>
              )
            )}
          </span>
        ) : null}
      </span>
    </CommandItem>
  )
}

// With nothing typed, the first page of each section.
function Suggestions({ onSelect }: { onSelect: (path: string) => void }) {
  return (
    <CommandGroup heading="Start here">
      {sections.map((section) => {
        const first = section.entries[0]
        if (!first) return null
        const Icon = section.icon
        return (
          <CommandItem
            key={section.id}
            value={first.path}
            onSelect={() => onSelect(first.path)}
            className="gap-3 px-3 py-2.5 [&>svg:last-child]:hidden"
          >
            <Icon className="text-primary-ink" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-foreground">
                {section.title}
              </span>
              <span className="block truncate text-[0.8125rem] text-muted-foreground">
                {section.summary}
              </span>
            </span>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

function groupByPage(results: Array<SearchResult>) {
  const groups = new Map<
    string,
    { path: string; results: Array<SearchResult>; title: string }
  >()
  for (const result of results) {
    const group = groups.get(result.entry.path) ?? {
      path: result.entry.path,
      results: [],
      title: result.entry.title,
    }
    group.results.push(result)
    groups.set(result.entry.path, group)
  }
  return [...groups.values()]
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center border border-border bg-muted/40 px-1 font-mono text-[0.6875rem] text-foreground">
      {children}
    </kbd>
  )
}

// The header's search field. It's a button that opens the dialog.
export function SearchButton({ className }: { className?: string }) {
  const open = useOpenSearch()
  const shortcut = React.useSyncExternalStore(
    noopSubscribe,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "⌘"
  )
  return (
    <button
      type="button"
      onClick={open}
      onPointerEnter={() => void preloadSearchIndex()}
      onFocus={() => void preloadSearchIndex()}
      className={cn(
        "flex h-9 items-center gap-2.5 border border-border bg-card/60 px-3 text-sm text-muted-foreground transition-colors outline-none hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        className
      )}
    >
      <Search className="size-4 shrink-0" />
      <span className="flex-1 text-left">Search the docs</span>
      <kbd className="hidden h-5 items-center gap-0.5 border border-border bg-muted/40 px-1.5 font-mono text-[0.6875rem] text-foreground sm:inline-flex">
        {shortcut} K
      </kbd>
    </button>
  )
}

function noopSubscribe() {
  return () => {}
}
