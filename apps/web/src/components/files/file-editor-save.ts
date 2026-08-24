import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import type { RelayFileContent } from "@workspace/contracts"
import { snbtDiagnostic } from "@workspace/contracts"

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
  expectedModifiedAt: string | undefined,
  force?: boolean
) => Promise<RelayFileContent>

export interface EditorSaveOptions {
  canWrite: boolean
  file: RelayFileContent
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

export async function saveEditorChanges(
  options: EditorSaveOptions,
  saveOptions: { force?: boolean } = {}
) {
  if (!canSaveEditor(options)) return

  const { file, saveFile, sessionStore } = options
  const content = sessionStore.getValue()
  if (!saveOptions.force) {
    const validationError = validateEditorContent(file, content)
    if (validationError) {
      sessionStore.setSaveError(validationError)
      return
    }
  }
  sessionStore.setSaving(true)
  sessionStore.setSaveError(null)
  await runEditorSave(
    () =>
      saveFile(
        content,
        sessionStore.getExpectedModifiedAt(),
        saveOptions.force
      ),
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
      sessionStore.markSaved(nextFile.content, nextFile.modifiedAt)
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
    (content: string, expectedModifiedAt: string | undefined, force = false) =>
      saveFile({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          path: file.path,
          content,
          expectedModifiedAt,
          ...(force ? { force: true } : {}),
        },
      }),
    [file.path, instance.id, instance.relayId, saveFile]
  )
}

export function isSnbtFile(file: RelayFileContent) {
  return (
    file.encoding === "snbt" ||
    file.encoding === "nbt" ||
    file.encoding === "nbt-gzip"
  )
}

function validateEditorContent(file: RelayFileContent, content: string) {
  if (!isSnbtFile(file)) return null
  const diagnostic = snbtDiagnostic(content, {
    binaryCompatible: !file.path.toLowerCase().endsWith(".snbt"),
  })
  return diagnostic?.message ?? null
}
