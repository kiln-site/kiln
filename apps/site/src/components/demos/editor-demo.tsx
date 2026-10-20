import * as React from "react"
import { RotateCcw, Save } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { SyntaxCodeEditor } from "@/components/syntax-code-editor"

import { demoFiles } from "~/components/demos/editor-files"

interface FileState {
  saved: string
  value: string
}

export default function EditorDemo() {
  const [activePath, setActivePath] = React.useState(demoFiles[0]!.path)
  const [files, setFiles] = React.useState<Record<string, FileState>>(() =>
    Object.fromEntries(
      demoFiles.map((file) => [
        file.path,
        { saved: file.saved, value: file.edited ?? file.saved },
      ])
    )
  )
  const active = files[activePath]!
  const dirty = active.value !== active.saved
  const changedLines = React.useMemo(
    () => countChangedLines(active.saved, active.value),
    [active.saved, active.value]
  )

  const update = React.useCallback(
    (value: string) =>
      setFiles((current) => ({
        ...current,
        [activePath]: { ...current[activePath]!, value },
      })),
    [activePath]
  )
  const ignoreSearch = React.useCallback(() => {}, [])

  return (
    <div className="flex h-full min-h-0 flex-col border border-border bg-card shadow-2xl shadow-black/40">
      <div
        role="tablist"
        aria-label="Files"
        className="flex shrink-0 [scrollbar-width:none] overflow-x-auto border-b"
      >
        {demoFiles.map((file) => {
          const state = files[file.path]!
          const selected = file.path === activePath
          return (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={selected}
              className="flex h-10 shrink-0 items-center gap-2 border-r border-b-2 border-b-transparent px-3.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:bg-accent/60 aria-selected:border-b-primary aria-selected:bg-background aria-selected:text-foreground"
              onClick={() => setActivePath(file.path)}
            >
              {file.name}
              {state.value !== state.saved ? (
                <span
                  aria-label="Unsaved changes"
                  className="size-1.5 bg-primary"
                />
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="type-meta flex h-9 shrink-0 items-center border-b bg-background px-3.5 font-mono text-muted-foreground">
        <span className="truncate">/data/{activePath}</span>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 bg-background">
        <SyntaxCodeEditor
          key={activePath}
          ariaLabel={`Edit ${activePath}`}
          disabled={false}
          fontSize={13}
          onChange={update}
          onSearchOpenChange={ignoreSearch}
          originalValue={active.saved}
          path={activePath}
          redactSensitive
          readOnly={false}
          searchOpen={false}
          searchQuery=""
          showChanges
          value={active.value}
          wrapLines={false}
        />
      </div>
      <div className="flex h-12 shrink-0 items-center gap-2 border-t px-3">
        <span className="type-meta min-w-0 truncate text-muted-foreground">
          {dirty
            ? `${changedLines} ${changedLines === 1 ? "line" : "lines"} changed`
            : "Saved"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!dirty}
          onClick={() => update(active.saved)}
        >
          <RotateCcw />
          Revert
        </Button>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() =>
            setFiles((current) => ({
              ...current,
              [activePath]: { saved: active.value, value: active.value },
            }))
          }
        >
          <Save />
          Save
        </Button>
      </div>
    </div>
  )
}

function countChangedLines(saved: string, value: string) {
  const before = saved.split("\n")
  const after = value.split("\n")
  let changed = 0
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] !== after[index]) changed += 1
  }
  return changed
}
