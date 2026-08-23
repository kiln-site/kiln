import { forkPromise, tapPromiseError } from "@/effect/promise"

let fileWorkspaceModulePromise:
  | Promise<typeof import("@/components/files/file-workspace")>
  | undefined

export function loadFileWorkspaceModule() {
  if (!fileWorkspaceModulePromise) {
    fileWorkspaceModulePromise = tapPromiseError(
      () => import("@/components/files/file-workspace"),
      (error) => {
        fileWorkspaceModulePromise = undefined
        throw error
      }
    )
  }

  return fileWorkspaceModulePromise
}

export function warmFileWorkspaceModule() {
  forkPromise(loadFileWorkspaceModule)
}
