import { publishRealtimeChange } from "@/lib/realtime-source.server"

const targetedBackupChangeLimit = 10

export function publishBackupChange(relayId: string, backupId?: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { ...(backupId ? { backupId } : {}), relayId },
    topics: ["backups"],
    type: "hearth.invalidate",
  })
}

export function publishBackupChanges(
  relayId: string,
  backupIds: ReadonlyArray<string>
): void {
  const uniqueBackupIds = [...new Set(backupIds)]
  if (uniqueBackupIds.length === 0) return
  if (uniqueBackupIds.length > targetedBackupChangeLimit) {
    publishBackupChange(relayId)
    return
  }
  uniqueBackupIds.forEach((backupId) => publishBackupChange(relayId, backupId))
}

export function publishBackupSettingsChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["backup-settings"],
    type: "hearth.invalidate",
  })
}

export function publishBackupStorageChange(ownerUserId: string | null): void {
  publishRealtimeChange({
    audience: { kind: "backup-storage", ownerUserId },
    topics: ["backup-storage"],
    type: "hearth.invalidate",
  })
}
