import { describe, expect, it } from "vite-plus/test"

import {
  publishBackupChange,
  publishBackupSettingsChange,
  publishBackupStorageChange,
} from "@/lib/backup-realtime.server"
import {
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "@/lib/realtime-source.server"

describe("backup realtime publishers", () => {
  it("keeps catalogs, policies, and storage on separate audiences", () => {
    const events: Array<RealtimeSourceEvent> = []
    const unsubscribe = subscribeRealtimeChanges((event) => events.push(event))

    publishBackupChange("relay-a")
    publishBackupSettingsChange("relay-a")
    publishBackupStorageChange("user-a")
    unsubscribe()

    expect(events).toMatchObject([
      {
        audience: { kind: "relays", relayIds: ["relay-a"] },
        scope: { relayId: "relay-a" },
        topics: ["backups"],
        type: "hearth.invalidate",
      },
      {
        audience: { kind: "relays", relayIds: ["relay-a"] },
        scope: { relayId: "relay-a" },
        topics: ["backup-settings"],
        type: "hearth.invalidate",
      },
      {
        audience: { kind: "backup-storage", ownerUserId: "user-a" },
        topics: ["backup-storage"],
        type: "hearth.invalidate",
      },
    ])
  })
})
