import type { RelayFileContent } from "@workspace/contracts"

import { useIsMobile } from "@workspace/ui/hooks/use-mobile"

import {
  EditorDownloadButton,
  EditorSaveButton,
  StableEditorMobileOverflowMenu,
  StableEditorOverflowMenu,
  StableEditorShareButton,
} from "@/components/files/file-editor-toolbar-actions"
import type { SaveFileRevision } from "@/components/files/file-editor-save"
import type {
  EditorSessionStore,
  FileEditorPreferencesStore,
} from "@/components/files/file-workspace-stores"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

export function EditorResponsiveActions({
  canShare,
  canWrite,
  file,
  instance,
  loading,
  preferencesStore,
  saveFile,
  sessionStore,
}: {
  canShare: boolean
  canWrite: boolean
  file: RelayFileContent
  instance: InstanceWorkspaceInstance
  loading: boolean
  preferencesStore: FileEditorPreferencesStore
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="ml-auto flex shrink-0 items-center gap-1 md:hidden">
        <EditorSaveButton
          canWrite={canWrite}
          file={file}
          loading={loading}
          saveFile={saveFile}
          sessionStore={sessionStore}
        />
        <StableEditorMobileOverflowMenu
          canShare={canShare}
          canWrite={canWrite}
          filePath={file.path}
          fileReadOnly={file.readOnly}
          file={file}
          instance={instance}
          loading={loading}
          preferencesStore={preferencesStore}
          saveFile={saveFile}
          sessionStore={sessionStore}
        />
      </div>
    )
  }

  return (
    <div
      className="ml-auto hidden max-w-full min-w-0 flex-wrap items-center justify-end gap-1 md:flex"
      data-file-editor-actions
    >
      {canShare ? (
        <StableEditorShareButton
          instance={instance}
          loading={loading}
          path={file.path}
          sessionStore={sessionStore}
        />
      ) : null}
      <EditorDownloadButton
        instance={instance}
        loading={loading}
        path={file.path}
      />
      <EditorSaveButton
        canWrite={canWrite}
        file={file}
        loading={loading}
        saveFile={saveFile}
        sessionStore={sessionStore}
      />
      <StableEditorOverflowMenu
        canWrite={canWrite}
        filePath={file.path}
        fileReadOnly={file.readOnly}
        file={file}
        instance={instance}
        loading={loading}
        preferencesStore={preferencesStore}
        saveFile={saveFile}
        sessionStore={sessionStore}
      />
    </div>
  )
}
