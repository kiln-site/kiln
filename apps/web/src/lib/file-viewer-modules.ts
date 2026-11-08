import type * as React from "react"

import type { FileContentViewerProps } from "@/components/files/file-content-viewer"
import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"
import type { FileContentViewerKind } from "@/lib/file-viewers"

type FileContentViewerComponent = React.ComponentType<FileContentViewerProps>

/**
 * Each viewer that reads a file its own way, loaded when a file needs it.
 * Adding a viewer is an entry here and a kind in `file-viewers.ts`.
 */
const viewerImports: Record<
  FileContentViewerKind,
  () => Promise<FileContentViewerComponent>
> = {
  database: () =>
    import("@/components/files/file-database-viewer").then(
      (module) => module.FileDatabaseViewer
    ),
}

export interface FileViewerModule {
  readonly load: () => Promise<FileContentViewerComponent>
  readonly loaded: () => FileContentViewerComponent | undefined
}

function onDemandViewer(kind: FileContentViewerKind): FileViewerModule {
  let pending: Promise<FileContentViewerComponent> | undefined
  let component: FileContentViewerComponent | undefined
  return {
    load: () => {
      pending ??= tapPromiseError(
        () =>
          traceFileWork(
            "viewer-module",
            { attributes: { "kiln.files.viewer": kind } },
            viewerImports[kind]
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

const viewerModules = Object.fromEntries(
  Object.keys(viewerImports).map((kind) => [
    kind,
    onDemandViewer(kind as FileContentViewerKind),
  ])
) as Record<FileContentViewerKind, FileViewerModule>

export function fileViewerModule(kind: FileContentViewerKind) {
  return viewerModules[kind]
}

export function warmFileViewerModule(kind: FileContentViewerKind) {
  forkPromise(viewerModules[kind].load)
}
