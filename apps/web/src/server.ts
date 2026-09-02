import * as Sentry from "@sentry/tanstackstart-react"
import { wrapFetchWithSentry } from "@sentry/tanstackstart-react"
import { createStartHandler } from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"
import { Effect } from "effect"

import { hearthStreamHandler } from "./app-server-handler"
import { disposeAppRuntime } from "./effect/runtime"
import { forkPromise } from "./effect/promise"
import { scheduleBackupCopyProcessing } from "./lib/backup-copy"
import { wakePendingAuthorizationDelivery } from "./lib/authorization-delivery"
import { scheduleInstancePostProvisionProcessing } from "./lib/instance-post-provision"
import { scheduleTailscaleCleanupProcessing } from "./lib/tailscale-cleanup.server"
import {
  initializeRelayFromEnvironment,
  maintainPersistedRelayConnections,
} from "./lib/relay-registry"

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
            Sentry.captureException(cause, {
              tags: { "kiln.operation": "relay.connection.maintain" },
            })
          })
        ),
        Effect.forkDetach
      )
    ),
    Effect.catch((cause) =>
      Effect.sync(() => {
        Sentry.captureException(cause, {
          tags: { "kiln.operation": "relay.bootstrap" },
        })
        console.warn("Automatic Relay pairing did not complete:", cause)
      })
    )
  )
)

scheduleBackupCopyProcessing()
scheduleInstancePostProvisionProcessing()
scheduleTailscaleCleanupProcessing()
forkPromise(wakePendingAuthorizationDelivery, (cause) => {
  Sentry.captureException(cause, {
    tags: { "kiln.operation": "authorization.delivery.recover" },
  })
})

const handleStartRequest = createStartHandler(hearthStreamHandler)

let shutdownPromise: Promise<void> | undefined

export function shutdownHearth(): Promise<void> {
  shutdownPromise ??= Promise.all([
    disposeAppRuntime(),
    Sentry.close(2_000),
  ]).then(() => undefined)
  return shutdownPromise
}

export default createServerEntry(
  wrapFetchWithSentry({
    fetch(request: Request) {
      return handleStartRequest(request)
    },
  })
)
