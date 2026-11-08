import type * as React from "react"

import type { FileContentViewerProps } from "@/components/files/file-content-viewer"
import type { FileTextViewProps } from "@/components/files/file-text-view"
import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"
import type {
  FileContentViewerKind,
  RenderedTextViewerKind,
} from "@/lib/file-viewers"

/**
 * Each viewer that reads a file its own way, loaded when a file needs it.
 * Adding a viewer is an entry here and a kind in `file-viewers.ts`.
 */
const viewerImports: Record<
  FileContentViewerKind,
  () => Promise<React.ComponentType<FileContentViewerProps>>
> = {
  database: () =>
    import("@/components/files/file-database-viewer").then(
      (module) => module.FileDatabaseViewer
    ),
  image: () =>
    import("@/components/files/image-viewer").then(
      (module) => module.ImageViewer
    ),
}

/**
 * The rendered view of each text file that has one, shown beside its
 * source in the editor.
 */
const textViewImports: Record<
  RenderedTextViewerKind,
  () => Promise<React.ComponentType<FileTextViewProps>>
> = {
  csv: () =>
    import("@/components/files/csv-table").then((module) => module.CsvTable),
  markdown: () =>
    import("@/components/files/markdown-preview").then(
      (module) => module.MarkdownPreview
    ),
}

export interface OnDemandComponent<TProps> {
  readonly load: () => Promise<React.ComponentType<TProps>>
  readonly loaded: () => React.ComponentType<TProps> | undefined
}

function onDemandComponent<TProps>(
  kind: string,
  importComponent: () => Promise<React.ComponentType<TProps>>
): OnDemandComponent<TProps> {
  let pending: Promise<React.ComponentType<TProps>> | undefined
  let component: React.ComponentType<TProps> | undefined
  return {
    load: () => {
      pending ??= tapPromiseError(
        () =>
          traceFileWork(
            "viewer-module",
            { attributes: { "kiln.files.viewer": kind } },
            importComponent
          ).then((loaded) => {
            component = loaded
            return loaded
          }),
        (error) => {
          pending = undefined
          throw error
        }
      )
      return pending
    },
    loaded: () => component,
  }
}

function onDemandComponents<TKind extends string, TProps>(
  imports: Record<TKind, () => Promise<React.ComponentType<TProps>>>
) {
  const entries = Object.entries(imports) as Array<
    [TKind, () => Promise<React.ComponentType<TProps>>]
  >
  return Object.fromEntries(
    entries.map(([kind, load]) => [kind, onDemandComponent(kind, load)])
  ) as Record<TKind, OnDemandComponent<TProps>>
}

const viewerModules = onDemandComponents(viewerImports)
const textViewModules = onDemandComponents(textViewImports)

export function fileViewerModule(kind: FileContentViewerKind) {
  return viewerModules[kind]
}

export function fileTextViewModule(kind: RenderedTextViewerKind) {
  return textViewModules[kind]
}

export function warmFileViewerModule(kind: FileContentViewerKind) {
  forkPromise(viewerModules[kind].load)
}

export function warmFileTextViewModule(kind: RenderedTextViewerKind) {
  forkPromise(textViewModules[kind].load)
}
