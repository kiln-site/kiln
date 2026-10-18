import * as React from "react"
import { Check, ChevronDown, LoaderCircle } from "lucide-react"

import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

export const BrickVersionPicker = React.memo(function BrickVersionPicker({
  className,
  disabled = false,
  emptyMessage = "No matching versions",
  labelledBy,
  loading = false,
  maxLength,
  minLength,
  name,
  onChange,
  pattern,
  placeholder = "Search versions…",
  required = false,
  value,
  versions,
}: {
  className?: string
  disabled?: boolean
  emptyMessage?: string
  labelledBy: string
  loading?: boolean
  maxLength?: number
  minLength?: number
  name: string
  onChange: (value: string) => void
  pattern?: string
  placeholder?: string
  required?: boolean
  value: string
  versions: ReadonlyArray<string>
}) {
  const anchorRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState(value)
  const [hasTyped, setHasTyped] = React.useState(false)
  const [side, setSide] = React.useState<"top" | "bottom">("bottom")
  const [sideLocked, setSideLocked] = React.useState(false)
  const [menuWidth, setMenuWidth] = React.useState<number>()
  const typedVersion = query.trim()
  const normalizedQuery = typedVersion.toLocaleLowerCase()
  const visibleVersions = React.useMemo(
    () => filteredVersions(versions, hasTyped ? normalizedQuery : ""),
    [hasTyped, normalizedQuery, versions]
  )
  const customVersion =
    hasTyped &&
    typedVersion.length > 0 &&
    !visibleVersions.some(
      (version) => version.toLocaleLowerCase() === normalizedQuery
    )
      ? typedVersion
      : null

  React.useEffect(() => {
    if (!open) setQuery(value)
  }, [open, value])

  React.useLayoutEffect(() => {
    if (!open) return
    setMenuWidth(anchorRef.current?.getBoundingClientRect().width)
  }, [open])

  React.useLayoutEffect(() => {
    if (!open || sideLocked) return
    const frame = window.requestAnimationFrame(() => {
      const placed = contentRef.current?.dataset.side
      if (placed === "top" || placed === "bottom") {
        setSide(placed)
        setSideLocked(true)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, sideLocked])

  const discardEditRef = React.useRef(false)

  const resetMenu = React.useCallback(() => {
    setOpen(false)
    setHasTyped(false)
    setSideLocked(false)
    setSide("bottom")
  }, [])

  const selectVersion = React.useCallback(
    (version: string) => {
      onChange(version)
      setQuery(version)
      resetMenu()
    },
    [onChange, resetMenu]
  )

  const closeMenu = React.useCallback(
    (commit: boolean) => {
      if (commit && typedVersion) onChange(typedVersion)
      setQuery(commit ? typedVersion || value : value)
      resetMenu()
    },
    [onChange, resetMenu, typedVersion, value]
  )

  const openMenu = React.useCallback(() => {
    discardEditRef.current = false
    setOpen(true)
    setHasTyped(false)
    setSideLocked(false)
    setSide("bottom")
  }, [])

  const keepMenuForAnchor = React.useCallback(
    (event: { target: EventTarget | null; preventDefault: () => void }) => {
      const target = event.target
      if (target instanceof Node && anchorRef.current?.contains(target)) {
        event.preventDefault()
      }
    },
    []
  )

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          openMenu()
          return
        }
        const discard = discardEditRef.current
        discardEditRef.current = false
        closeMenu(!discard)
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative">
          <Input
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-expanded={open}
            aria-labelledby={labelledBy}
            autoComplete="off"
            className={cn(
              "pr-8 font-mono text-xs tabular-nums md:text-xs",
              className
            )}
            disabled={disabled}
            maxLength={maxLength}
            minLength={minLength}
            name={name}
            pattern={pattern}
            placeholder={loading ? "Loading versions…" : placeholder}
            required={required}
            role="combobox"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              const next = event.currentTarget.value
              setQuery(next)
              if (!open) openMenu()
              if (next !== query) setHasTyped(true)
            }}
            onFocus={(event) => {
              openMenu()
              event.currentTarget.select()
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                discardEditRef.current = true
                closeMenu(false)
                discardEditRef.current = false
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                if (!hasTyped) {
                  closeMenu(true)
                  return
                }
                const next = visibleVersions[0] ?? customVersion
                if (next) selectVersion(next)
                else closeMenu(true)
              }
            }}
          />
          {/* A prefilled version needs no list to show, so only an empty
              field shows that versions are loading. */}
          {loading && !value ? (
            <LoaderCircle className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        align="start"
        avoidCollisions={!sideLocked}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={keepMenuForAnchor}
        onInteractOutside={keepMenuForAnchor}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()}
        side={side}
        sideOffset={4}
        style={menuWidth ? { width: menuWidth } : undefined}
        className="z-[70] w-auto min-w-0 p-1"
      >
        <div
          id={listId}
          role="listbox"
          aria-label="Supported versions"
          className="no-scrollbar max-h-52 space-y-0.5 overflow-y-auto overscroll-contain"
        >
          {loading && versions.length === 0 && !customVersion ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              Loading versions…
            </p>
          ) : visibleVersions.length === 0 && !customVersion ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            <>
              {visibleVersions.map((version) => {
                const selected = version === value
                return (
                  <button
                    key={version}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors duration-150",
                      selected
                        ? "bg-primary/14 ring-1 ring-primary/35"
                        : "hover:bg-accent/55"
                    )}
                    onClick={() => selectVersion(version)}
                  >
                    <span className="truncate font-mono text-xs tabular-nums">
                      {version}
                    </span>
                    {selected ? (
                      <Check className="size-3.5 shrink-0 text-primary" />
                    ) : null}
                  </button>
                )
              })}
              {customVersion ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={customVersion === value}
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-accent/55"
                  onClick={() => selectVersion(customVersion)}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono tabular-nums">
                      '{customVersion}'
                    </span>{" "}
                    <span className="text-muted-foreground">not found</span>
                  </span>
                </button>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
})

function filteredVersions(
  versions: ReadonlyArray<string>,
  normalizedQuery: string
): Array<string> {
  if (!normalizedQuery) return [...versions]
  const matches: Array<string> = []
  let exact: string | undefined
  for (const version of versions) {
    const normalized = version.toLocaleLowerCase()
    if (normalized === normalizedQuery) exact = version
    else if (normalized.includes(normalizedQuery)) matches.push(version)
  }
  return exact ? [exact, ...matches] : matches
}
