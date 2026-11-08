import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"
import {
  warmFileTextViewModule,
  warmFileViewerModule,
} from "@/lib/file-viewer-modules"
import {
  fileViewerKind,
  fileViewerReadsText,
  fileViewerRendersText,
} from "@/lib/file-viewers"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

type FileWorkspaceModule = typeof import("@/components/files/file-workspace")

let fileWorkspaceModulePromise: Promise<FileWorkspaceModule> | undefined
let fileWorkspaceModule: FileWorkspaceModule | undefined

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

/** Warm only the preview a file path is likely to use. */
export function warmFilePreviewModule(path: string) {
  if (!path || path.endsWith("/")) return
  const kind = fileViewerKind(path)
  if (!fileViewerReadsText(kind)) {
    warmFileViewerModule(kind)
    return
  }
  // A file that renders opens rendered, with its editor ready behind it.
  if (fileViewerRendersText(kind)) warmFileTextViewModule(kind)
  warmSyntaxCodeEditorModule()
}
