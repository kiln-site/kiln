import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"
import { isDatabaseFilePath } from "@/lib/database-files"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

type FileWorkspaceModule = typeof import("@/components/files/file-workspace")
type FileDatabaseViewerModule =
  typeof import("@/components/files/file-database-viewer")

let fileWorkspaceModulePromise: Promise<FileWorkspaceModule> | undefined
let fileWorkspaceModule: FileWorkspaceModule | undefined
let fileDatabaseViewerModulePromise:
  | Promise<FileDatabaseViewerModule>
  | undefined
let fileDatabaseViewerModule: FileDatabaseViewerModule | undefined

export function loadFileWorkspaceModule() {
  if (!fileWorkspaceModulePromise) {
    fileWorkspaceModulePromise = tapPromiseError(
      () =>
        traceFileWork(
          "workspace-module",
          {},
          () => import("@/components/files/file-workspace")
        ).then((module) => {
          fileWorkspaceModule = module
          return module
        }),
      (error) => {
        fileWorkspaceModulePromise = undefined
        throw error
      }
    )
  }

  return fileWorkspaceModulePromise
}

/** The file workspace module, once it has loaded. */
export function loadedFileWorkspaceModule() {
  return fileWorkspaceModule
}

export function warmFileWorkspaceModule() {
  forkPromise(loadFileWorkspaceModule)
}

export function loadFileDatabaseViewerModule() {
  if (!fileDatabaseViewerModulePromise) {
    fileDatabaseViewerModulePromise = tapPromiseError(
      () =>
        traceFileWork(
          "database-module",
          {},
          () => import("@/components/files/file-database-viewer")
        ).then((module) => {
          fileDatabaseViewerModule = module
          return module
        }),
      (error) => {
        fileDatabaseViewerModulePromise = undefined
        throw error
      }
    )
  }
  return fileDatabaseViewerModulePromise
}

export function loadedFileDatabaseViewerModule() {
  return fileDatabaseViewerModule
}

/** Warm only the preview a file path is likely to use. */
export function warmFilePreviewModule(path: string) {
  if (!path || path.endsWith("/")) return
  if (isDatabaseFilePath(path)) forkPromise(loadFileDatabaseViewerModule)
  else warmSyntaxCodeEditorModule()
}
