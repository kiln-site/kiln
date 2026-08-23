import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import type { RelayFileContent } from "@workspace/contracts"

import type { EditorSessionStore } from "@/components/files/file-workspace-stores"
import { queryKeys } from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { saveRelayFile } from "@/server/relay"

export async function runEditorSave(
  save: () => Promise<unknown>,
  sessionStore: EditorSessionStore,
  fallbackMessage: string
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({ try: save, catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() =>
          sessionStore.setSaveError(
            cause instanceof Error ? cause.message : fallbackMessage
          )
        )
      ),
      Effect.ensuring(
        Effect.sync(() => {
          sessionStore.setSaving(false)
        })
      )
    )
  )
}

export type SaveFileRevision = (
  content: string,
  expectedModifiedAt: string | undefined
) => Promise<RelayFileContent>

export interface EditorSaveOptions {
  canWrite: boolean
  fileReadOnly: boolean
  loading: boolean
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}

export function canSaveEditor({
  canWrite,
  fileReadOnly,
  loading,
  sessionStore,
}: EditorSaveOptions) {
  return (
    canWrite &&
    !fileReadOnly &&
    !loading &&
    sessionStore.getDirtySnapshot() &&
    !sessionStore.getDiskConflictSnapshot() &&
    !sessionStore.getSavingSnapshot()
  )
}

export async function saveEditorChanges(options: EditorSaveOptions) {
  if (!canSaveEditor(options)) return

  const { saveFile, sessionStore } = options
  sessionStore.setSaving(true)
  sessionStore.setSaveError(null)
  await runEditorSave(
    () =>
      saveFile(sessionStore.getValue(), sessionStore.getExpectedModifiedAt()),
    sessionStore,
    "Save failed"
  )
}

export function useFileSaveAction(
  file: RelayFileContent,
  instance: InstanceWorkspaceInstance,
  sessionStore: EditorSessionStore
) {
  const queryClient = useQueryClient()
  const saveMutation = useMutation({
    mutationFn: saveRelayFile,
    onSuccess: async (nextFile, variables) => {
      sessionStore.markSaved(variables.data.content, nextFile.modifiedAt)
      queryClient.setQueryData(
        queryKeys.relay.file(
          variables.data.relayId,
          variables.data.instanceId,
          variables.data.path
        ),
        nextFile
      )
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.fileActivity(
          variables.data.relayId,
          variables.data.instanceId
        ),
      })
    },
  })
  const saveFile = saveMutation.mutateAsync

  return React.useCallback(
    (content: string, expectedModifiedAt: string | undefined) =>
      saveFile({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          path: file.path,
          content,
          expectedModifiedAt,
        },
      }),
    [file.path, instance.id, instance.relayId, saveFile]
  )
}
