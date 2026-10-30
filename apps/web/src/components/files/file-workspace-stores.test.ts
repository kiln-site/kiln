import { describe, expect, it } from "vite-plus/test"

import { createEditorSessionStore } from "@/components/files/file-workspace-stores"

const firstRevision = "2026-07-23T12:00:00.000Z"
const secondRevision = "2026-07-23T12:01:00.000Z"
describe("editor session revisions", () => {
  it("freezes dirty text and its conflict token when disk changes", () => {
    const store = createEditorSessionStore("cached", firstRevision)
    store.setValue("local edit")

    store.reconcileDiskRevision("remote edit", secondRevision)

    expect(store.getValue()).toBe("local edit")
    expect(store.getSavedValueSnapshot()).toBe("cached")
    expect(store.getExpectedModifiedAt()).toBe(firstRevision)
    expect(store.getDiskConflictSnapshot()).toBe(true)
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
})
