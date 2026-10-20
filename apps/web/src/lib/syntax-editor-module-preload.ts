import { forkPromise, tapPromiseError } from "@/effect/promise"
import { traceFileWork } from "@/lib/file-timing"

type SyntaxCodeEditorModule = typeof import("@/components/syntax-code-editor")

let syntaxCodeEditorModulePromise: Promise<SyntaxCodeEditorModule> | undefined
let syntaxCodeEditorModule: SyntaxCodeEditorModule | undefined

export function loadSyntaxCodeEditorModule() {
  if (!syntaxCodeEditorModulePromise) {
    syntaxCodeEditorModulePromise = tapPromiseError(
      () =>
        traceFileWork(
          "editor-module",
          {},
          () => import("@/components/syntax-code-editor")
        ).then((module) => {
          syntaxCodeEditorModule = module
          return module
        }),
      (error) => {
        syntaxCodeEditorModulePromise = undefined
        throw error
      }
    )
  }

  return syntaxCodeEditorModulePromise
}

export function loadedSyntaxCodeEditorModule() {
  return syntaxCodeEditorModule
}

export function warmSyntaxCodeEditorModule() {
  forkPromise(loadSyntaxCodeEditorModule)
}

export function warmSyntaxCodeEditorModuleWhenIdle() {
  if (typeof window === "undefined") return

  let idleCallback: number | undefined
  let fallbackTimeout: ReturnType<typeof setTimeout> | undefined
  let secondFrame: number | undefined
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => {
      if ("requestIdleCallback" in window) {
        idleCallback = window.requestIdleCallback(warmSyntaxCodeEditorModule, {
          timeout: 2_000,
        })
        return
      }
      fallbackTimeout = setTimeout(warmSyntaxCodeEditorModule, 500)
    })
  })

  return () => {
    window.cancelAnimationFrame(firstFrame)
    if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame)
    if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback)
    if (fallbackTimeout !== undefined) clearTimeout(fallbackTimeout)
  }
}
