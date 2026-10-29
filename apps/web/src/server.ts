import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { createStartHandler } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { Effect, Schedule } from "effect"

import { hearthStreamHandler } from "./app-server-handler"
import { loadInstallationId } from "./effect/installation"
import { migrateDatabase } from "./effect/migrations"
import {
  disposeAppRuntime,
  forkAppEffect,
  reportAppError,
} from "./effect/runtime"
import { forkPromise } from "./effect/promise"
import { resumeInvitationDelivery } from "./lib/access-invitation-delivery"
import { scheduleBackupCopyProcessing } from "./lib/backup-copy"
import { stopWarmCacheRefreshes } from "./lib/cache"
import { wakePendingAuthorizationDelivery } from "./lib/authorization-delivery"
import { scheduleInstancePostProvisionProcessing } from "./lib/instance-post-provision"
import { stopPollingWorkers } from "./lib/polling-worker"
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
import { resumeTailscaleNetworkDeletion } from "./lib/tailscale-cleanup.server"
import {
  startAppImageUpdateChecks,
  stopAppImageUpdateChecks,
} from "./lib/app-image-updates.server"
import {
  startIconDetection,
  stopIconDetection,
} from "./lib/icon-detection.server"
import { startDiskLimitWarnings } from "./lib/disk-limit-warnings.server"
import { startNotificationPushes } from "./lib/notification-pushes.server"
import { startDnsWorker } from "./lib/dns-worker.server"
import { startOperationsEngine } from "./operations/startup"
import { startServerMigrationResumption } from "./lib/server-migrations.server"
import {
  startBackupMaintenance,
  stopBackupMaintenance,
} from "./lib/backup-maintenance.server"
import {
  initializeRelayFromEnvironment,
  maintainPersistedRelayConnections,
} from "./lib/relay-registry"
import { relayConnectionsCapacity } from "./lib/relay-connection"
import { handleRelayControlUpgrade } from "./lib/relay-control-dial.server"
import {
  startSecurityScans,
  stopSecurityScans,
} from "./lib/security-scans.server"
import { startRelayMetrics, stopRelayMetrics } from "./lib/relay-metrics"
import { relayPassthroughUsages } from "./lib/relay-passthrough-limits.server"
import { stopScheduleDeliveries } from "./server/schedule-deployment.server"

await migrateDatabase()
// Before the app runtime starts, so telemetry carries the ID, and before
// Relays connect, since Hearth sends it to them.
await loadInstallationId()
startInstanceDirectorySync()
startGitHubSyncPolling()
startAppDeploymentPolling()
startAppImageUpdateChecks()
startIconDetection()
startSecurityScans()
startRelayMetrics(relayConnectionsCapacity, relayPassthroughUsages)

const pairRelayFromEnvironment = Effect.tryPromise({
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
  )
)

await Effect.runPromise(
  pairRelayFromEnvironment.pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        reportAppError(cause, { operation: "relay.bootstrap" })
        console.warn("Automatic Relay pairing did not complete:", cause)
      }).pipe(
        // The Relay may still be starting, as when one that installed Kiln
        // restarts beside it. Keep trying for half an hour.
        Effect.andThen(
          pairRelayFromEnvironment.pipe(
            Effect.retry({
              schedule: Schedule.spaced("15 seconds"),
              times: 120,
            }),
            Effect.delay("15 seconds"),
            Effect.catch((retryCause) =>
              Effect.sync(() => {
                reportAppError(retryCause, { operation: "relay.bootstrap" })
                console.warn(
                  "Automatic Relay pairing gave up; pair the Relay from the Relays page:",
                  retryCause
                )
              })
            ),
            Effect.forkDetach
          )
        )
      )
    )
  )
)

// Invitations the old delivery worker hadn't sent go through the lanes.
forkAppEffect(
  "invitations.resumeDelivery",
  resumeInvitationDelivery().pipe(
    Effect.retry(Schedule.spaced("30 seconds")),
    Effect.ignore
  )
)
scheduleBackupCopyProcessing()
scheduleInstancePostProvisionProcessing()
forkAppEffect(
  "TailscaleCleanup.resume",
  resumeTailscaleNetworkDeletion().pipe(
    Effect.retry(Schedule.spaced("30 seconds")),
    Effect.ignore
  )
)
startKilnUpdateNotifications()
startDiskLimitWarnings()
startNotificationPushes()
startBackupMaintenance()
startServerMigrationResumption()
startDnsWorker()
startOperationsEngine()
forkPromise(wakePendingAuthorizationDelivery, (cause) => {
  reportAppError(cause, { operation: "authorization.delivery.recover" })
})

const handleStartRequest = createStartHandler(hearthStreamHandler)

/**
 * Takes a WebSocket upgrade the fetch handler can't: a Relay opening its
 * control connection to Hearth. False for any other.
 */
export function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  return handleRelayControlUpgrade(request, socket, head)
}

let shutdownPromise: Promise<void> | undefined

export function shutdownHearth(): Promise<void> {
  // Disposing the runtime also flushes pending telemetry.
  shutdownPromise ??= Promise.all([
    stopInstanceDirectorySync(),
    stopGitHubSyncPolling(),
    stopAppDeploymentPolling(),
    stopAppImageUpdateChecks(),
    stopIconDetection(),
    stopBackupMaintenance(),
    stopPollingWorkers(),
    stopSecurityScans(),
    stopRelayMetrics(),
    stopScheduleDeliveries(),
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
