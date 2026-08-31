import * as React from "react"
import { Search, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  useDataTableSearchInput,
  type DataTableSearchStore,
} from "@/lib/data-table-search"

export const DataTableWorkspace = React.memo(function DataTableWorkspace({
  before,
  children,
  className,
  toolbar,
}: {
  before?: React.ReactNode
  children: React.ReactNode
  className?: string
  toolbar: React.ReactNode
}) {
  return (
    <section
      data-slot="data-table-workspace"
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45 [contain:paint]",
        className
      )}
    >
      {before}
      {toolbar}
      <div
        data-slot="data-table-viewport"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {children}
      </div>
    </section>
  )
})

interface DataTableToolbarSearchOptions {
  ariaLabel: string
  closeMobileWhenEmpty?: boolean
  id?: string
  maxLength?: number
  placeholder: string
  store: DataTableSearchStore
  onValueChange?: (value: string) => void
}

export const DataTableToolbar = React.memo(function DataTableToolbar({
  actions,
  controls,
  leading,
  search,
}: {
  actions?: React.ReactNode
  controls?: React.ReactNode
  leading?: React.ReactNode
  search: DataTableToolbarSearchOptions
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(
    () => search.store.getSnapshot().length > 0
  )
  useDataTableSearchInput(inputRef, search.store)

  React.useEffect(() => {
    if (mobileSearchOpen) inputRef.current?.focus()
  }, [mobileSearchOpen])

  const setSearch = React.useCallback(
    (value: string) => {
      search.store.set(value)
      search.onValueChange?.(value)
      if (search.closeMobileWhenEmpty && value.length === 0) {
        setMobileSearchOpen(false)
      }
    },
    [search]
  )

  return (
    <div
      data-slot="data-table-toolbar"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b bg-background/25 p-3"
    >
      {leading}
      {!mobileSearchOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-controls={search.id}
              aria-expanded={false}
              aria-label={search.ariaLabel}
              className="sm:hidden"
              size="icon"
              type="button"
              variant="outline"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {search.ariaLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <div
        className={cn(
          "relative min-w-0 flex-1 sm:block sm:max-w-md",
          mobileSearchOpen ? "block" : "hidden"
        )}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          aria-label={search.ariaLabel}
          className="pl-9 text-base md:text-sm"
          defaultValue={search.store.getServerSnapshot()}
          id={search.id}
          maxLength={search.maxLength}
          placeholder={search.placeholder}
          type="search"
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
      {mobileSearchOpen ? (
        <Button
          aria-label={`Close ${search.ariaLabel.toLocaleLowerCase()}`}
          className="sm:hidden"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            setMobileSearchOpen(false)
            setSearch("")
          }}
        >
          <X />
        </Button>
      ) : null}
      {controls ? (
        <div
          className={cn(
            "shrink-0 items-center gap-2",
            mobileSearchOpen ? "hidden sm:flex" : "flex"
          )}
        >
          {controls}
        </div>
      ) : null}
      {actions ? (
        <div
          className={cn(
            "ml-auto shrink-0 items-center gap-2",
            mobileSearchOpen ? "hidden sm:flex" : "flex"
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  )
})
