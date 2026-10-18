import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"

type FileWorkspaceModule = typeof import("@/components/files/file-workspace")

let fileWorkspaceModulePromise: Promise<FileWorkspaceModule> | undefined
let fileWorkspaceModule: FileWorkspaceModule | undefined

export function loadFileWorkspaceModule() {
  if (!fileWorkspaceModulePromise) {
    fileWorkspaceModulePromise = tapPromiseError(
      () =>
        traceFileWork("workspace-module", {}, () =>
          import("@/components/files/file-workspace")
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
