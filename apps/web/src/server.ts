import { createStartHandler } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { Effect } from "effect"

import { hearthStreamHandler } from "./app-server-handler"
import { migrateDatabase } from "./effect/migrations"
import { disposeAppRuntime, reportAppError } from "./effect/runtime"
import { forkPromise } from "./effect/promise"
import { startAccessInvitationDelivery } from "./lib/access-invitation-delivery"
import { scheduleBackupCopyProcessing } from "./lib/backup-copy"
import { wakePendingAuthorizationDelivery } from "./lib/authorization-delivery"
import { scheduleInstancePostProvisionProcessing } from "./lib/instance-post-provision"
import { startKilnUpdateNotifications } from "./lib/kiln-update-notifications"
import { scheduleTailscaleCleanupProcessing } from "./lib/tailscale-cleanup.server"
import {
  initializeRelayFromEnvironment,
  maintainPersistedRelayConnections,
} from "./lib/relay-registry"

await migrateDatabase()

await Effect.runPromise(
  Effect.tryPromise({
    try: initializeRelayFromEnvironment,
    catch: (cause) => cause,
  }).pipe(
    Effect.tap((relay) =>
      Effect.sync(() => {
        if (relay) console.log(`Automatically paired Relay ${relay.name}`)
      })
    ),
    Effect.tap(() =>
      Effect.tryPromise({
        try: maintainPersistedRelayConnections,
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            reportAppError(cause, { operation: "relay.connection.maintain" })
          })
        ),
        Effect.forkDetach
      )
    ),
    Effect.catch((cause) =>
      Effect.sync(() => {
        reportAppError(cause, { operation: "relay.bootstrap" })
        console.warn("Automatic Relay pairing did not complete:", cause)
      })
    )
  )
)

startAccessInvitationDelivery()
scheduleBackupCopyProcessing()
scheduleInstancePostProvisionProcessing()
scheduleTailscaleCleanupProcessing()
startKilnUpdateNotifications()
forkPromise(wakePendingAuthorizationDelivery, (cause) => {
  reportAppError(cause, { operation: "authorization.delivery.recover" })
})

const handleStartRequest = createStartHandler(hearthStreamHandler)

let shutdownPromise: Promise<void> | undefined

export function shutdownHearth(): Promise<void> {
  // Disposing the runtime also flushes pending telemetry.
  shutdownPromise ??= disposeAppRuntime()
  return shutdownPromise
}

export default createServerEntry({
  fetch(request: Request) {
    return handleStartRequest(request)
  },
})
