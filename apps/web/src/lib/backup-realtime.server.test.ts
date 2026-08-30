import { describe, expect, it } from "vite-plus/test"

import {
  publishBackupChange,
  publishBackupChanges,
  publishBackupSettingsChange,
  publishBackupStorageChange,
} from "@/lib/backup-realtime.server"
import {
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "@/lib/realtime-source.server"

type HearthInvalidateEvent = Extract<
  RealtimeSourceEvent,
  { type: "hearth.invalidate" }
>

describe("backup realtime publishers", () => {
  it("keeps catalogs, policies, and storage on separate audiences", () => {
    const events: Array<RealtimeSourceEvent> = []
    const unsubscribe = subscribeRealtimeChanges((event) => events.push(event))

    publishBackupChange("relay-a", "7ff61850-2e5e-4238-b960-755b743a246a")
    publishBackupSettingsChange("relay-a")
    publishBackupStorageChange("user-a")
    unsubscribe()

    expect(events).toMatchObject([
      {
        audience: { kind: "relays", relayIds: ["relay-a"] },
        scope: {
          backupId: "7ff61850-2e5e-4238-b960-755b743a246a",
          relayId: "relay-a",
        },
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

  it("collapses large reconciliation batches into one catalog refresh", () => {
    const events: Array<HearthInvalidateEvent> = []
    const unsubscribe = subscribeRealtimeChanges((event) => {
      if (event.type === "hearth.invalidate") events.push(event)
    })

    publishBackupChanges(
      "relay-a",
      Array.from({ length: 11 }, (_, index) => `backup-${index}`)
    )
    unsubscribe()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      audience: { kind: "relays", relayIds: ["relay-a"] },
      scope: { relayId: "relay-a" },
      topics: ["backups"],
      type: "hearth.invalidate",
    })
    expect(events[0]?.scope).not.toHaveProperty("backupId")
  })

  it("keeps small reconciliation batches targeted and unique", () => {
    const events: Array<HearthInvalidateEvent> = []
    const unsubscribe = subscribeRealtimeChanges((event) => {
      if (event.type === "hearth.invalidate") events.push(event)
    })

    publishBackupChanges("relay-a", ["backup-a", "backup-a", "backup-b"])
    unsubscribe()

    expect(events.map((event) => event.scope?.backupId)).toEqual([
      "backup-a",
      "backup-b",
    ])
  })
})
