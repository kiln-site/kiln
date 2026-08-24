import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createEditorSessionStore,
  createFileEditorPreferencesStore,
  deletedPathContainsSelection,
} from "@/components/files/file-workspace-stores"

const firstRevision = "2026-07-23T12:00:00.000Z"
const secondRevision = "2026-07-23T12:01:00.000Z"
const fontSizeStorageKey = "kiln:file-editor-font-size"

afterEach(() => vi.unstubAllGlobals())

function installBrowserStorage({
  fontSize,
  width,
}: {
  fontSize?: number
  width: number
}) {
  const values = new Map<string, string>()
  if (fontSize !== undefined) {
    values.set(fontSizeStorageKey, String(fontSize))
  }
  vi.stubGlobal("window", {
    innerWidth: width,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  return values
}

function installMobileQuery(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<() => void>()
  Object.assign(window, {
    matchMedia: () => ({
      get matches() {
        return matches
      },
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
    }),
  })

  return {
    listenerCount: () => listeners.size,
    setMatches(nextMatches: boolean) {
      matches = nextMatches
      for (const listener of listeners) listener()
    },
  }
}

describe("file editor font size preferences", () => {
  it("uses 12px by default and removes the desktop override at 12px", () => {
    const storage = installBrowserStorage({ width: 1280 })
    const store = createFileEditorPreferencesStore()

    store.hydrate()
    expect(store.getFontSizeSnapshot()).toBe(12)

    store.setFontSize(14)
    expect(storage.get(fontSizeStorageKey)).toBe("14")

    store.setFontSize(12)
    expect(storage.has(fontSizeStorageKey)).toBe(false)
  })

  it("uses 16px on mobile and removes the mobile override at 16px", () => {
    const storage = installBrowserStorage({ width: 390 })
    const store = createFileEditorPreferencesStore()

    store.hydrate()
    expect(store.getFontSizeSnapshot()).toBe(16)

    store.setFontSize(14)
    expect(storage.get(fontSizeStorageKey)).toBe("14")

    store.setFontSize(16)
    expect(storage.has(fontSizeStorageKey)).toBe(false)
  })

  it("keeps a stored browser override across responsive defaults", () => {
    installBrowserStorage({ fontSize: 14, width: 390 })
    const store = createFileEditorPreferencesStore()

    store.hydrate()
    expect(store.getFontSizeSnapshot()).toBe(14)

    store.setDefaultFontSize(12)
    expect(store.getFontSizeSnapshot()).toBe(14)
  })

  it("keeps an explicit override that equals the other viewport default", () => {
    const storage = installBrowserStorage({ fontSize: 12, width: 390 })
    const store = createFileEditorPreferencesStore()

    store.hydrate()
    expect(store.getFontSizeSnapshot()).toBe(12)

    store.setDefaultFontSize(12)
    store.setDefaultFontSize(16)
    expect(store.getFontSizeSnapshot()).toBe(12)
    expect(storage.get(fontSizeStorageKey)).toBe("12")
  })

  it("follows measured viewport changes without a stored override", () => {
    installBrowserStorage({ width: 390 })
    const mobileQuery = installMobileQuery(true)
    const store = createFileEditorPreferencesStore()

    store.hydrate()
    const stopObserving = store.observeViewport()
    expect(store.getFontSizeSnapshot()).toBe(16)
    expect(mobileQuery.listenerCount()).toBe(1)

    mobileQuery.setMatches(false)
    expect(store.getFontSizeSnapshot()).toBe(12)

    mobileQuery.setMatches(true)
    expect(store.getFontSizeSnapshot()).toBe(16)

    stopObserving()
    expect(mobileQuery.listenerCount()).toBe(0)
  })
})

describe("editor session revisions", () => {
  it("adopts a newer disk revision while the session is clean", () => {
    const store = createEditorSessionStore("cached", firstRevision)

    store.reconcileDiskRevision("fresh", secondRevision)

    expect(store.getValue()).toBe("fresh")
    expect(store.getSavedValueSnapshot()).toBe("fresh")
    expect(store.getExpectedModifiedAt()).toBe(secondRevision)
    expect(store.getDiskConflictSnapshot()).toBe(false)
  })

  it("freezes dirty text and its conflict token when disk changes", () => {
    const store = createEditorSessionStore("cached", firstRevision)
    store.setValue("local edit")

    store.reconcileDiskRevision("remote edit", secondRevision)

    expect(store.getValue()).toBe("local edit")
    expect(store.getSavedValueSnapshot()).toBe("cached")
    expect(store.getExpectedModifiedAt()).toBe(firstRevision)
    expect(store.getDiskConflictSnapshot()).toBe(true)
  })

  it("reloads or overwrites a conflicted session only when explicitly chosen", () => {
    const reloaded = createEditorSessionStore("cached", firstRevision)
    reloaded.setValue("local edit")
    reloaded.reconcileDiskRevision("remote edit", secondRevision)
    reloaded.reloadFromDisk("remote edit", secondRevision)

    expect(reloaded.getValue()).toBe("remote edit")
    expect(reloaded.getDirtySnapshot()).toBe(false)
    expect(reloaded.getExpectedModifiedAt()).toBe(secondRevision)
    expect(reloaded.getDiskConflictSnapshot()).toBe(false)

    const overwritten = createEditorSessionStore("cached", firstRevision)
    overwritten.setValue("local edit")
    overwritten.reconcileDiskRevision("remote edit", secondRevision)
    overwritten.markSaved("local edit", secondRevision)

    expect(overwritten.getValue()).toBe("local edit")
    expect(overwritten.getDirtySnapshot()).toBe(false)
    expect(overwritten.getExpectedModifiedAt()).toBe(secondRevision)
    expect(overwritten.getDiskConflictSnapshot()).toBe(false)
  })

  it("keeps edits made during a save dirty against the saved revision", () => {
    const store = createEditorSessionStore("cached", firstRevision)
    store.setValue("submitted edit")
    store.setValue("edit typed while saving")

    store.markSaved("submitted edit", secondRevision)

    expect(store.getValue()).toBe("edit typed while saving")
    expect(store.getSavedValueSnapshot()).toBe("submitted edit")
    expect(store.getDirtySnapshot()).toBe(true)
    expect(store.getExpectedModifiedAt()).toBe(secondRevision)
  })

  it("adopts the newer disk revision if a conflicted edit becomes clean", () => {
    const store = createEditorSessionStore("cached", firstRevision)
    store.setValue("local edit")
    store.reconcileDiskRevision("remote edit", secondRevision)
    store.setValue("cached")

    store.reconcileDiskRevision("remote edit", secondRevision)

    expect(store.getValue()).toBe("remote edit")
    expect(store.getDirtySnapshot()).toBe(false)
    expect(store.getDiskConflictSnapshot()).toBe(false)
  })
})

describe("file workspace path handling", () => {
  it("only treats exact files and actual directory descendants as deleted", () => {
    expect(deletedPathContainsSelection("m", "mods/foo")).toBe(false)
    expect(deletedPathContainsSelection("server", "server.properties")).toBe(
      false
    )
    expect(
      deletedPathContainsSelection("server.properties", "server.properties")
    ).toBe(true)
    expect(deletedPathContainsSelection("mods/", "mods/foo")).toBe(true)
    expect(deletedPathContainsSelection("mods/", "mods/")).toBe(true)
    expect(deletedPathContainsSelection("mods/", "mods-old/foo")).toBe(false)
  })
})
