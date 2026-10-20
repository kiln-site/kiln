import { createStartHandler } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { Effect } from "effect"

import { hearthStreamHandler } from "./app-server-handler"
import { loadInstallationId } from "./effect/installation"
import { migrateDatabase } from "./effect/migrations"
import { disposeAppRuntime, reportAppError } from "./effect/runtime"
import { forkPromise } from "./effect/promise"
import { startAccessInvitationDelivery } from "./lib/access-invitation-delivery"
import { scheduleBackupCopyProcessing } from "./lib/backup-copy"
import { stopWarmCacheRefreshes } from "./lib/cache"
import { wakePendingAuthorizationDelivery } from "./lib/authorization-delivery"
import { scheduleInstancePostProvisionProcessing } from "./lib/instance-post-provision"
import { startKilnUpdateNotifications } from "./lib/kiln-update-notifications"
import {
  startInstanceDirectorySync,
  stopInstanceDirectorySync,
} from "./lib/instance-directory-sync"
import {
  startGitHubSyncPolling,
  stopGitHubSyncPolling,
} from "./lib/github-sync.server"
import {
  startAppDeploymentPolling,
  stopAppDeploymentPolling,
} from "./lib/app-deployments.server"
import { scheduleTailscaleCleanupProcessing } from "./lib/tailscale-cleanup.server"
import { startDiskLimitWarnings } from "./lib/disk-limit-warnings.server"
import {
  initializeRelayFromEnvironment,
  maintainPersistedRelayConnections,
} from "./lib/relay-registry"
import { relayConnectionsCapacity } from "./lib/relay-connection"
import { startRelayMetrics, stopRelayMetrics } from "./lib/relay-metrics"

await migrateDatabase()
// Before the app runtime starts, so telemetry carries the ID, and before
// Relays connect, since Hearth sends it to them.
await loadInstallationId()
startInstanceDirectorySync()
startGitHubSyncPolling()
startAppDeploymentPolling()
startRelayMetrics(relayConnectionsCapacity)

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
startDiskLimitWarnings()
forkPromise(wakePendingAuthorizationDelivery, (cause) => {
  reportAppError(cause, { operation: "authorization.delivery.recover" })
})

const handleStartRequest = createStartHandler(hearthStreamHandler)

let shutdownPromise: Promise<void> | undefined

export function shutdownHearth(): Promise<void> {
  // Disposing the runtime also flushes pending telemetry.
  shutdownPromise ??= Promise.all([
    stopInstanceDirectorySync(),
    stopGitHubSyncPolling(),
    stopAppDeploymentPolling(),
    stopRelayMetrics(),
  ])
    .then(() => Effect.runPromise(stopWarmCacheRefreshes))
    .then(disposeAppRuntime)
  return shutdownPromise
}

export default createServerEntry({
  fetch(request: Request) {
    return handleStartRequest(request)
  },
})
