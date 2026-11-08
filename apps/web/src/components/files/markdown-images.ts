import * as React from "react"

import { forkPromise } from "@/effect/promise"
import { readRelayFile } from "@/lib/relay-file-transfer"

// A document's images are read from the Relay as it renders, so a README
// full of screenshots stays within what one person's transfers may use.
export const MAX_DOCUMENT_IMAGE_BYTES = 16 * 1024 * 1024
export const MAX_DOCUMENT_IMAGES_BYTES = 64 * 1024 * 1024
export const MAX_DOCUMENT_IMAGES = 64
// Under the Relay's share of transfers for one browser.
export const DOCUMENT_IMAGE_READS_AT_ONCE = 4

export type DocumentImageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string }
  /** Past the document's budget, so only linked. */
  | { readonly status: "skipped" }

export interface DocumentImages {
  /** Starts reading the image at `path` once, however often it appears. */
  readonly request: (path: string, type: string) => void
  readonly get: (path: string) => DocumentImageState | undefined
  readonly subscribe: (listener: () => void) => () => void
  /** Stops what's still reading and releases every image. */
  readonly dispose: () => void
}

/**
 * One document's images: each read once, a few at a time, within a budget
 * of how many and how much; past it, images are only linked.
 */
export function createDocumentImages(root: {
  readonly instanceId: string
  readonly relayId: string
}): DocumentImages {
  const states = new Map<string, DocumentImageState>()
  const queue: Array<{ path: string; type: string }> = []
  const listeners = new Set<() => void>()
  const controllers = new Set<AbortController>()
  const urls: Array<string> = []
  let reading = 0
  let reserved = 0
  let used = 0
  let disposed = false

  const set = (path: string, state: DocumentImageState) => {
    states.set(path, state)
    for (const listener of listeners) listener()
  }

  const pump = () => {
    while (!disposed && reading < DOCUMENT_IMAGE_READS_AT_ONCE) {
      const next = queue.shift()
      if (!next) return
      const allowance = Math.min(
        MAX_DOCUMENT_IMAGE_BYTES,
        MAX_DOCUMENT_IMAGES_BYTES - used - reserved
      )
      if (allowance <= 0) {
        set(next.path, { status: "skipped" })
        continue
      }
      reading += 1
      reserved += allowance
      const controller = new AbortController()
      controllers.add(controller)
      const settle = () => {
        reading -= 1
        reserved -= allowance
        controllers.delete(controller)
        pump()
      }
      forkPromise(
        async () => {
          const blob = await readRelayFile({
            ...root,
            maxBytes: allowance,
            path: next.path,
            signal: controller.signal,
          })
          if (disposed) return
          const url = URL.createObjectURL(new Blob([blob], { type: next.type }))
          urls.push(url)
          used += blob.size
          set(next.path, { status: "ready", url })
          settle()
        },
        (cause) => {
          if (disposed) return
          set(next.path, {
            status: "failed",
            message:
              cause instanceof Error && cause.message
                ? cause.message
                : "Could not read the image",
          })
          settle()
        }
      )
    }
  }

  return {
    request: (path, type) => {
      if (disposed || states.has(path)) return
      if (states.size >= MAX_DOCUMENT_IMAGES) {
        states.set(path, { status: "skipped" })
        return
      }
      states.set(path, { status: "loading" })
      queue.push({ path, type })
      pump()
    },
    get: (path) => states.get(path),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      queue.length = 0
      for (const controller of controllers) controller.abort()
      for (const url of urls) URL.revokeObjectURL(url)
      listeners.clear()
    },
  }
}

export const DocumentImagesContext = React.createContext<DocumentImages | null>(
  null
)

/** The state of the document's image at `path`, asking for it to be read. */
export function useDocumentImage(
  path: string | null,
  type: string | undefined
): DocumentImageState | undefined {
  const images = React.useContext(DocumentImagesContext)
  React.useEffect(() => {
    if (images && path && type) images.request(path, type)
  }, [images, path, type])
  const subscribe = React.useCallback(
    (listener: () => void) => images?.subscribe(listener) ?? (() => {}),
    [images]
  )
  const getSnapshot = React.useCallback(
    () => (images && path ? images.get(path) : undefined),
    [images, path]
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** A document's images, for as long as it's shown for this file. */
export function useDocumentImages(root: {
  readonly instanceId: string
  readonly path: string
  readonly relayId: string
}): DocumentImages | null {
  const { instanceId, path, relayId } = root
  const [images, setImages] = React.useState<DocumentImages | null>(null)
  React.useEffect(() => {
    const created = createDocumentImages({ instanceId, relayId })
    setImages(created)
    return () => created.dispose()
  }, [instanceId, path, relayId])
  return images
}
