import * as Sentry from "@sentry/tanstackstart-react"
import { Result } from "effect"

import { mobileBreakpoint } from "@workspace/ui/hooks/use-mobile"

export const fileEditorFontSizes = [10, 11, 12, 14, 16]
const fileEditorFontSizeStorageKey = "kiln:file-editor-font-size"
const desktopFileEditorFontSize = 12
const mobileFileEditorFontSize = 16

export function defaultFileEditorFontSize(isMobile: boolean): number {
  return isMobile ? mobileFileEditorFontSize : desktopFileEditorFontSize
}

export function deletedPathContainsSelection(
  deletedPath: string,
  selectedPath: string
): boolean {
  return deletedPath.endsWith("/")
    ? selectedPath === deletedPath || selectedPath.startsWith(deletedPath)
    : selectedPath === deletedPath
}

export interface EditorSearchStore {
  getSnapshot: () => string
  setQuery: (query: string) => void
  subscribe: (listener: () => void) => () => void
}

export interface FileEditorPreferencesStore {
  getFontSizeSnapshot: () => number
  hydrate: () => void
  setDefaultFontSize: (fontSize: number) => void
  setFontSize: (fontSize: number) => void
  subscribe: (listener: () => void) => () => void
}

export interface EditorSessionStore {
  getDiskConflictSnapshot: () => boolean
  getDirtySnapshot: () => boolean
  getExpectedModifiedAt: () => string
  getReviewChangesSnapshot: () => boolean
  getSavedValueSnapshot: () => string
  getSaveErrorSnapshot: () => string | null
  getSavingSnapshot: () => boolean
  getSearchOpenSnapshot: () => boolean
  getValue: () => string
  getValueSnapshot: () => string
  getWrapLinesSnapshot: () => boolean
  markSaved: (value: string, modifiedAt: string) => void
  reconcileDiskRevision: (value: string, modifiedAt: string) => void
  reloadFromDisk: (value: string, modifiedAt: string) => void
  setSaveError: (error: string | null) => void
  setSaving: (saving: boolean) => void
  setSearchOpen: (open: boolean) => void
  setValue: (value: string) => void
  subscribe: (listener: () => void) => () => void
  toggleReviewChanges: () => void
  toggleWrapLines: () => void
}

export interface FileSelectionStore {
  cancelNavigation: () => void
  completeNavigation: (path: string, result: "loaded" | "unavailable") => void
  getIsHomeSnapshot: () => boolean
  getSnapshot: () => string
  navigate: (path: string, from: string, to: string) => void
  select: (path: string) => void
  subscribe: (listener: () => void) => () => void
}

export function createFileSelectionStore(
  initialPath: string
): FileSelectionStore {
  let path = initialPath
  let navigation:
    | {
        path: string
        span: ReturnType<typeof Sentry.startInactiveSpan>
      }
    | undefined
  const listeners = new Set<() => void>()
  const select = (nextPath: string) => {
    if (path === nextPath) return
    path = nextPath
    for (const listener of listeners) listener()
  }
  return {
    cancelNavigation: () => {
      if (!navigation) return
      navigation.span.setAttribute("kiln.file.result", "cancelled")
      navigation.span.end()
      navigation = undefined
    },
    completeNavigation: (completedPath, result) => {
      if (navigation?.path !== completedPath) return
      navigation.span.setAttribute("kiln.file.result", result)
      navigation.span.end()
      navigation = undefined
    },
    getIsHomeSnapshot: () => path === "",
    getSnapshot: () => path,
    navigate: (nextPath, from, to) => {
      if (navigation) {
        navigation.span.setAttribute("kiln.file.result", "superseded")
        navigation.span.end()
      }
      Sentry.addBreadcrumb({
        category: "navigation",
        type: "navigation",
        data: { from, to },
      })
      navigation = {
        path: nextPath,
        span: Sentry.startInactiveSpan({
          name: to,
          op: "navigation",
          forceTransaction: true,
          attributes: {
            "sentry.source": "route",
            "kiln.navigation.type": "file",
          },
        }),
      }
      select(nextPath)
    },
    select,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createEditorSearchStore(): EditorSearchStore {
  let query = ""
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => query,
    setQuery: (nextQuery) => {
      if (query === nextQuery) return
      query = nextQuery
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createFileEditorPreferencesStore(): FileEditorPreferencesStore {
  let currentDefaultFontSize = desktopFileEditorFontSize
  let fontSize = currentDefaultFontSize
  let hasStoredOverride = false
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const updateFontSize = (nextFontSize: number) => {
    if (fontSize === nextFontSize) return
    fontSize = nextFontSize
    notify()
  }
  const setDefaultFontSize = (nextDefaultFontSize: number) => {
    if (
      currentDefaultFontSize === nextDefaultFontSize ||
      !fileEditorFontSizes.includes(nextDefaultFontSize)
    ) {
      return
    }
    currentDefaultFontSize = nextDefaultFontSize
    if (!hasStoredOverride) updateFontSize(nextDefaultFontSize)
  }
  const setFontSize = (nextFontSize: number) => {
    if (!fileEditorFontSizes.includes(nextFontSize)) return
    hasStoredOverride = nextFontSize !== currentDefaultFontSize
    Result.try(() => {
      if (hasStoredOverride) {
        window.localStorage.setItem(
          fileEditorFontSizeStorageKey,
          String(nextFontSize)
        )
      } else {
        window.localStorage.removeItem(fileEditorFontSizeStorageKey)
      }
    })
    // The editor remains usable when browser storage is unavailable.
    updateFontSize(nextFontSize)
  }
  return {
    getFontSizeSnapshot: () => fontSize,
    hydrate: () => {
      Result.try(() => {
        setDefaultFontSize(
          defaultFileEditorFontSize(window.innerWidth < mobileBreakpoint)
        )
        const stored = window.localStorage.getItem(
          fileEditorFontSizeStorageKey
        )
        const storedValue = Number.parseInt(stored ?? "", 10)
        hasStoredOverride = fileEditorFontSizes.includes(storedValue)
        if (!hasStoredOverride && stored !== null) {
          window.localStorage.removeItem(fileEditorFontSizeStorageKey)
        }
        updateFontSize(
          hasStoredOverride ? storedValue : currentDefaultFontSize
        )
      })
      // Keep the default when browser storage is unavailable.
    },
    setDefaultFontSize,
    setFontSize,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createEditorSessionStore(
  initialValue: string,
  initialModifiedAt: string
): EditorSessionStore {
  let value = initialValue
  let savedValue = initialValue
  let expectedModifiedAt = initialModifiedAt
  let diskConflict = false
  let dirty = false
  let saving = false
  let saveError: string | null = null
  let searchOpen = false
  let reviewChanges = true
  let wrapLines = true
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const reloadFromDisk = (nextValue: string, nextModifiedAt: string) => {
    value = nextValue
    savedValue = nextValue
    expectedModifiedAt = nextModifiedAt
    diskConflict = false
    dirty = false
    saveError = null
    notify()
  }
  return {
    getDiskConflictSnapshot: () => diskConflict,
    getDirtySnapshot: () => dirty,
    getExpectedModifiedAt: () => expectedModifiedAt,
    getReviewChangesSnapshot: () => reviewChanges,
    getSavedValueSnapshot: () => savedValue,
    getSaveErrorSnapshot: () => saveError,
    getSavingSnapshot: () => saving,
    getSearchOpenSnapshot: () => searchOpen,
    getValue: () => value,
    getValueSnapshot: () => value,
    getWrapLinesSnapshot: () => wrapLines,
    markSaved: (nextSavedValue, nextModifiedAt) => {
      savedValue = nextSavedValue
      expectedModifiedAt = nextModifiedAt
      diskConflict = false
      dirty = value !== savedValue
      notify()
    },
    reconcileDiskRevision: (nextValue, nextModifiedAt) => {
      if (Date.parse(nextModifiedAt) <= Date.parse(expectedModifiedAt)) {
        return
      }
      if (dirty) {
        if (diskConflict) return
        diskConflict = true
        notify()
        return
      }
      reloadFromDisk(nextValue, nextModifiedAt)
    },
    reloadFromDisk,
    setSaveError: (nextError) => {
      if (saveError === nextError) return
      saveError = nextError
      notify()
    },
    setSaving: (nextSaving) => {
      if (saving === nextSaving) return
      saving = nextSaving
      notify()
    },
    setSearchOpen: (nextOpen) => {
      if (searchOpen === nextOpen) return
      searchOpen = nextOpen
      notify()
    },
    setValue: (nextValue) => {
      if (value === nextValue) return
      value = nextValue
      const nextDirty = value !== savedValue
      dirty = nextDirty
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggleReviewChanges: () => {
      reviewChanges = !reviewChanges
      notify()
    },
    toggleWrapLines: () => {
      wrapLines = !wrapLines
      notify()
    },
  }
}
