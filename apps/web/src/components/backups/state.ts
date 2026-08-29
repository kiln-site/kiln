import {
  createWorkspaceTableSearchStore,
  type WorkspaceTableSearchStore,
} from "@/components/workspace-data-table"
import type { getBackups } from "@/server/backups"

export type Backup = Awaited<ReturnType<typeof getBackups>>[number]
export type BackupAvailabilityDestination = {
  enabled: boolean
  id: string | null
  name: string
  ownerUserId: string | null
}
export interface BackupFilters {
  kind?: "database" | "relay" | "server"
  relay?: string
  search?: string
  server?: string
  status?: "active" | "available" | "failed"
}

export type BackupSearchStore = WorkspaceTableSearchStore
export type BackupStatusFilterStore = ReturnType<
  typeof createBackupStatusFilterStore
>
export type BackupDialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { backup: Backup; kind: "delete" }
  | { backup: Backup; kind: "download" }
  | { backup: Backup; kind: "restore" }
export type BackupDialogStore = ReturnType<typeof createBackupDialogStore>
export type BackupDeleteFeedbackStore = ReturnType<
  typeof createBackupDeleteFeedbackStore
>
export type BackupSelectionStore = ReturnType<typeof createBackupSelectionStore>
export type BackupNameStore = ReturnType<typeof createBackupNameStore>

export function createBackupSearchStore(initialValue: string) {
  return createWorkspaceTableSearchStore(initialValue)
}

const closedBackupDialog = { kind: "closed" } as const
const emptyBackupDeleteFeedback: ReadonlyMap<string, Backup> = new Map()
const emptyBackupSelection: ReadonlySet<string> = new Set()

export function createBackupDialogStore() {
  let state: BackupDialogState = closedBackupDialog
  const listeners = new Set<() => void>()

  function publish(next: BackupDialogState) {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    close: () => publish(closedBackupDialog),
    getServerSnapshot: () => closedBackupDialog,
    getSnapshot: () => state,
    open: (next: Exclude<BackupDialogState, { kind: "closed" }>) =>
      publish(next),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createBackupSelectionStore() {
  let selected: ReadonlySet<string> = emptyBackupSelection
  const listeners = new Set<() => void>()

  function publish(next: ReadonlySet<string>) {
    if (next === selected) return
    selected = next
    for (const listener of listeners) listener()
  }

  return {
    clear: () => {
      if (selected.size > 0) publish(emptyBackupSelection)
    },
    deselect: (backupIds: ReadonlyArray<string>) => {
      const next = new Set(selected)
      for (const backupId of backupIds) next.delete(backupId)
      if (next.size !== selected.size) publish(next)
    },
    getServerSnapshot: () => emptyBackupSelection,
    getSnapshot: () => selected,
    retain: (backupIds: ReadonlySet<string>) => {
      const next = new Set([...selected].filter((id) => backupIds.has(id)))
      if (next.size !== selected.size) publish(next)
    },
    replace: (backupIds: Iterable<string>) => {
      const next = new Set(backupIds)
      if (
        next.size === selected.size &&
        [...next].every((backupId) => selected.has(backupId))
      ) {
        return
      }
      publish(next)
    },
    select: (backupIds: ReadonlyArray<string>) => {
      const next = new Set(selected)
      for (const backupId of backupIds) next.add(backupId)
      if (next.size !== selected.size) publish(next)
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggle: (backupId: string) => {
      const next = new Set(selected)
      if (next.has(backupId)) next.delete(backupId)
      else next.add(backupId)
      publish(next)
    },
  }
}

export function createBackupNameStore() {
  let revision = 0
  const names = new Map<string, string>()
  const listeners = new Set<() => void>()
  const backupListeners = new Map<string, Set<() => void>>()

  function publish(backupIds: ReadonlySet<string>) {
    revision += 1
    for (const listener of listeners) listener()
    for (const backupId of backupIds) {
      for (const listener of backupListeners.get(backupId) ?? []) listener()
    }
  }

  return {
    get: (backupId: string, fallback: string) =>
      names.get(backupId) ?? fallback,
    getRevision: () => revision,
    set: (backupId: string, name: string) => {
      if (names.get(backupId) === name) return
      names.set(backupId, name)
      publish(new Set([backupId]))
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeToBackup: (backupId: string, listener: () => void) => {
      const current = backupListeners.get(backupId) ?? new Set()
      current.add(listener)
      backupListeners.set(backupId, current)
      return () => {
        current.delete(listener)
        if (current.size === 0) backupListeners.delete(backupId)
      }
    },
    sync: (entries: ReadonlyArray<readonly [string, string]>) => {
      const changed = new Set<string>()
      for (const [backupId, name] of entries) {
        if (names.get(backupId) === name) continue
        names.set(backupId, name)
        changed.add(backupId)
      }
      if (changed.size > 0) publish(changed)
    },
  }
}

export function createBackupStatusFilterStore(
  initial: BackupFilters["status"]
) {
  let status = initial
  const listeners = new Set<() => void>()

  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => status,
    set: (next: BackupFilters["status"]) => {
      if (next === status) return
      status = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createBackupDeleteFeedbackStore() {
  let deleting: ReadonlyMap<string, Backup> = emptyBackupDeleteFeedback
  const listeners = new Set<() => void>()

  function publish(next: ReadonlyMap<string, Backup>) {
    if (next === deleting) return
    deleting = next
    for (const listener of listeners) listener()
  }

  return {
    getServerSnapshot: () => emptyBackupDeleteFeedback,
    getSnapshot: () => deleting,
    mark: (backups: ReadonlyArray<Backup>) => {
      const next = new Map(deleting)
      for (const backup of backups) next.set(backup.id, backup)
      publish(next)
    },
    remove: (backupIds: ReadonlyArray<string>) => {
      const next = new Map(deleting)
      for (const backupId of backupIds) next.delete(backupId)
      if (next.size !== deleting.size) publish(next)
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
