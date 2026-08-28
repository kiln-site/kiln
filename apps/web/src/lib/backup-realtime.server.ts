import { publishRealtimeChange } from "@/lib/realtime-source.server"

export function publishBackupChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["backups"],
    type: "hearth.invalidate",
  })
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
