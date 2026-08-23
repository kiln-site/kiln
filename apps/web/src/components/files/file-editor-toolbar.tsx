import type { RelayFileContent } from "@workspace/contracts"

import { useIsMobile } from "@workspace/ui/hooks/use-mobile"

import {
  EditorDownloadButton,
  EditorSaveButton,
  StableEditorCopyButton,
  StableEditorFontSizeButton,
  StableEditorMobileOverflowMenu,
  StableEditorOverflowMenu,
  StableEditorShareButton,
  StableEditorWrapButton,
} from "@/components/files/file-editor-toolbar-actions"
import { EditorSearchToggleButton } from "@/components/files/file-editor-search"
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
        <EditorSearchToggleButton
          loading={loading}
          sessionStore={sessionStore}
        />
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
          instance={instance}
          loading={loading}
          preferencesStore={preferencesStore}
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
      <EditorSearchToggleButton loading={loading} sessionStore={sessionStore} />
      <StableEditorFontSizeButton preferencesStore={preferencesStore} />
      <StableEditorWrapButton sessionStore={sessionStore} />
      <StableEditorCopyButton sessionStore={sessionStore} />
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
        instance={instance}
        loading={loading}
        sessionStore={sessionStore}
      />
    </div>
  )
}
