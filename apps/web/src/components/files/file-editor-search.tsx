import * as React from "react"
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Popover, PopoverContent } from "@workspace/ui/components/popover"

import type { SyntaxCodeEditorHandle } from "@/components/syntax-code-editor"
import type {
  EditorSearchStore,
  EditorSessionStore,
} from "@/components/files/file-workspace-stores"

export function EditorSearchBoundary({
  children,
  editorRef,
  inputRef,
  searchStore,
  sessionStore,
}: {
  children: React.ReactElement
  editorRef: React.RefObject<SyntaxCodeEditorHandle | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  searchStore: EditorSearchStore
  sessionStore: EditorSessionStore
}) {
  const open = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSearchOpenSnapshot,
    sessionStore.getSearchOpenSnapshot
  )

  return (
    <Popover open={open} onOpenChange={sessionStore.setSearchOpen}>
      {children}
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={12}
        className="w-[min(18rem,calc(100vw-1rem))] p-2"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <EditorSearchContent
          editorRef={editorRef}
          inputRef={inputRef}
          store={searchStore}
          onClose={() => sessionStore.setSearchOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

function EditorSearchContent({
  editorRef,
  inputRef,
  onClose,
  store,
}: {
  editorRef: React.RefObject<SyntaxCodeEditorHandle | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  onClose: () => void
  store: EditorSearchStore
}) {
  const query = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          aria-label="Find in file"
          className="h-8 bg-background/70 pr-2 pl-8 font-mono text-base shadow-none md:text-xs"
          placeholder="Find in file…"
          spellCheck={false}
          onChange={(event) => store.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            if (event.shiftKey) editorRef.current?.findPrevious()
            else editorRef.current?.findNext()
          }}
        />
      </div>
      <div className="flex shrink-0 items-center">
        <div className="flex h-10 w-9 flex-col gap-px">
          <button
            type="button"
            className="grid min-h-0 flex-1 place-items-center text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
            aria-label="Previous match"
            disabled={!query}
            onClick={() => editorRef.current?.findPrevious()}
          >
            <ChevronUp className="size-[18px]" />
          </button>
          <button
            type="button"
            className="grid min-h-0 flex-1 place-items-center text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
            aria-label="Next match"
            disabled={!query}
            onClick={() => editorRef.current?.findNext()}
          >
            <ChevronDown className="size-[18px]" />
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Close file search"
          onClick={onClose}
        >
          <X className="size-[18px]" />
        </Button>
      </div>
    </div>
  )
}
