import * as React from "react"
import { Code2, Eye, Image as ImageIcon, Table2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import type { EditorSessionStore } from "@/components/files/file-workspace-stores"
import { fileTextViewModule } from "@/lib/file-viewer-modules"
import type { RenderedTextViewerKind } from "@/lib/file-viewers"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { usePreloadedModule } from "@/lib/use-preloaded-module"

/** What a text file's rendered view is given. */
export interface FileTextViewProps {
  readonly displayPath: string
  readonly instance: FileWorkspaceInstance
  /** Opens another path in the workspace, as a document's link does. */
  readonly onOpenPath: (path: string) => void
  readonly path: string
  /** The editor's text, unsaved changes included. */
  readonly sessionStore: EditorSessionStore
}

/** How each kind of text file names its rendered view. */
const renderedViews: Record<
  RenderedTextViewerKind,
  { readonly icon: LucideIcon; readonly label: string }
> = {
  csv: { icon: Table2, label: "Table" },
  markdown: { icon: Eye, label: "Preview" },
  svg: { icon: ImageIcon, label: "Image" },
}

export type FileTextViewMode = "rendered" | "source"

export interface FileTextViewStore {
  getSnapshot: () => FileTextViewMode
  set: (mode: FileTextViewMode) => void
  subscribe: (listener: () => void) => () => void
}

/** Which of a file's views is showing; a file opens rendered. */
export function createFileTextViewStore(): FileTextViewStore {
  let mode: FileTextViewMode = "rendered"
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => mode,
    set: (next) => {
      if (mode === next) return
      mode = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useFileTextViewMode(store: FileTextViewStore) {
  return React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
}

/** Switches a text file between its source and its rendered view. */
export const FileTextViewToggle = React.memo(function FileTextViewToggle({
  kind,
  store,
}: {
  kind: RenderedTextViewerKind
  store: FileTextViewStore
}) {
  const mode = useFileTextViewMode(store)
  const rendered = renderedViews[kind]
  const options = [
    { icon: rendered.icon, label: rendered.label, mode: "rendered" },
    { icon: Code2, label: "Source", mode: "source" },
  ] as const
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 border bg-muted/20 p-0.5"
      role="group"
      aria-label="View"
    >
      {options.map((option) => (
        <EditorTooltip key={option.mode} content={`Show ${option.label}`}>
          <Button
            type="button"
            variant={mode === option.mode ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={mode === option.mode}
            onClick={() => store.set(option.mode)}
          >
            <option.icon className="size-3.5" />
            <span className="hidden sm:inline">{option.label}</span>
          </Button>
        </EditorTooltip>
      ))}
    </div>
  )
})

/** A text file's rendered view, once its module has loaded. */
export function FileTextView({
  kind,
  ...props
}: FileTextViewProps & { kind: RenderedTextViewerKind }) {
  const module = fileTextViewModule(kind)
  const View = usePreloadedModule(module.load, module.loaded)
  if (!View) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
        <FileWorkspaceLoadingState
          title={`Opening ${renderedViews[kind].label.toLowerCase()}`}
          description="Preparing the rendered view."
        />
      </div>
    )
  }
  return <View {...props} />
}
