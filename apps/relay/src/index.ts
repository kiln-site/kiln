import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { hostname } from "node:os"
import * as Sentry from "@sentry/node"
import { Effect, Semaphore } from "effect"

import {
  backupTaskIdSchema,
  backupTaskInputSchema,
  redactRelayBackupTask,
  relayConsoleCommandSchema,
  relayConsoleCompletionInputSchema,
  relayConsoleShareInputSchema,
  relayCreateDatabaseSchema,
  relayDatabaseActionSchema,
  relayDatabaseDumpSchema,
  relayDatabaseExportSchema,
  relayDatabaseNetworkSchema,
  relayDeleteDatabaseSchema,
  relayAuditQuerySchema,
  relayCreateInstanceSchema,
  relayPrepareInstanceSchema,
  relayProvisionInstanceSchema,
  relayInstanceActionSchema,
  relayInstanceNameSchema,
  relayInstanceSchema,
  relayInstancePortLeaseReleaseSchema,
  relayInstancePortLeaseRequestSchema,
  relayInstancePortInputsSchema,
  relayInstanceWebRouteInputsSchema,
  relayNetworkingSchema,
  relayProxySettingsSchema,
  relayDirectoryPageInputSchema,
  relayFileMutationInputSchema,
  relayFileSearchPageInputSchema,
  relayFileStatInputSchema,
  relayRemoteFileUploadResultSchema,
  relayRemoteFileUploadSchema,
  relaySaveFileInputSchema,
  relayTailscaleInstallSchema,
  relayTailscaleSettingsSchema,
  relayTailscaleStackApplySchema,
  relayTailscaleStackDnsSchema,
  relayTailscaleStackRemoveSchema,
  relayRotateDatabaseCredentialsSchema,
  relayUpdateInstanceStartupSchema,
  relayBootstrapDiscoveryTranscript,
  relayScheduleProjectionSchema,
} from "@workspace/contracts"
import type {
  RelayControlOperation,
  RelayControlRequest,
  RelayInstance,
} from "@workspace/contracts"

import { BrickCatalog } from "./bricks.js"
import { BackupDownloadServer } from "./backup-download.js"
import { BackupManager } from "./backups.js"
import { attachBrowserSocket } from "./browser-socket.js"
import {
  discoverRelayAdvertisedHost,
  discoverRelayGameHost,
  loadConfig,
} from "./config.js"
import { attachControlSocket } from "./control-socket.js"
import { DockerDriver } from "./docker.js"
import { DatabaseDriver } from "./databases.js"
import {
  inspectEncryptedPlatformBackup,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
import { FilesystemDriver } from "./files.js"
import { LifecycleDriver } from "./lifecycle.js"
import { nodeSnapshot } from "./node.js"
import { RelayPairingError } from "./effect/errors.js"
import {
  loadOrCreateRelayIdentity,
  renameRelayIdentity,
} from "./effect/identity.js"
import {
  decodePairingRequest,
  createPairingInvitation,
  initializePairing,
  pairHearth,
  renderPairingInvitation,
} from "./effect/pairing.js"
import {
  disposeRelayRuntime,
  forkRelayEffect,
  initializeRelayRuntime,
  runRelayEffect,
} from "./effect/runtime.js"
import { RelayStateStore } from "./effect/state.js"
import type {
  RelayClientGrant,
  RelayClientRole,
  RelayStoredPendingPrimaryPort,
} from "./effect/state.js"
import { loadRelayTls } from "./effect/tls.js"
import { applyStoredInstanceNames } from "./instance-names.js"
import { normalizedRoute } from "./route-label.js"
import { uploadConsoleLogToMclogs } from "./mclogs.js"
import { closeRelayServer } from "./shutdown.js"
import { attachSftpServer } from "./sftp-server.js"
import { actionsForRole, relayActions } from "./permissions.js"
import type { RelayAction } from "./permissions.js"
import { normalizeSourceCidrs } from "./source-policy.js"
import { withRemoteFileSource } from "./remote-file-source.js"
import { RelaySnapshotHub } from "./snapshot-hub.js"
import { retainProvisioningInstances } from "./instance-mutation-snapshot.js"
import { RuntimeRecoveryManager } from "./runtime-recovery.js"
import { ProvisioningManager } from "./provisioning.js"
import { SystemUpdateManager } from "./system-updates.js"
import { ScheduleManager } from "./schedules.js"
import { assignRelayWebRouteIds } from "./web-route-ids.js"
import { planWebRouteRecovery } from "./web-route-labels.js"
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from "node:http"

const WEB_ROUTE_RECOVERY_METADATA_KEY = "web_routes_recovery_v1"

const config = loadConfig()
const advertisedHostSource = await discoverRelayAdvertisedHost(config)
if (advertisedHostSource !== "configured") {
  console.warn(
    advertisedHostSource === "public_ip"
      ? `KILN_RELAY_HOST was not set; inferred ${config.advertisedHost} from public DNS.`
      : `KILN_RELAY_HOST was not set; using hostname ${config.advertisedHost}.`
  )
  console.warn(
    "The inferred Relay endpoint is unverified and may be unusable behind NAT, inside Docker, or when an origin address should remain hidden. Set KILN_RELAY_HOST explicitly after checking reachability."
  )
}
const gameHostSource = await discoverRelayGameHost(config)
if (gameHostSource === "public_ip") {
  console.info(
    `KILN_RELAY_GAME_HOST=public-ip; discovered ${config.gameHost} from public DNS for game traffic.`
  )
}
await mkdir(config.rootDirectory, { recursive: true })
await mkdir(`${config.dataDirectory}/network`, {
  recursive: true,
  mode: 0o700,
})
initializeRelayRuntime(config)
const startupCore = await runRelayEffect(
  "relay.startup",
  Effect.gen(function* () {
    const state = yield* RelayStateStore
    const identity = yield* loadOrCreateRelayIdentity(config)
    return { identity, state }
  })
)
const cliArguments = process.argv.slice(2)
let relayIdentity = startupCore.identity
config.nodeId = relayIdentity.fingerprint
config.nodeName = relayIdentity.name
const bricks = new BrickCatalog(config.brickCatalogUrl, config.dataDirectory)
const runtimeRecovery = new RuntimeRecoveryManager(config, startupCore.state)
await runRelayEffect(
  "relay.startup.runtimeRecovery",
  runtimeRecovery.initialize()
)
const docker = new DockerDriver(config, runtimeRecovery, bricks)
const databases = new DatabaseDriver(config, docker)
const systemUpdates = new SystemUpdateManager(config)
const filesystem = new FilesystemDriver(config)
const lifecycle = new LifecycleDriver(config, docker, bricks)
const startupProxySettings = await lifecycle.proxySettings()
lifecycle.hydrateProxySettings(startupProxySettings)
let activeTls = await runRelayEffect("relay.startup.tls", loadRelayTls(config))
const startup = { ...startupCore, tls: activeTls }
if (
  cliArguments[0] === "pair" ||
  cliArguments[0] === "hearth" ||
  cliArguments[0] === "platform-backup"
) {
  await runRelayCli(cliArguments)
  await disposeRelayRuntime()
  process.exit(0)
}
const initialPairing = await runRelayEffect(
  "relay.startup.pairing",
  initializePairing({
    config,
    identity: relayIdentity,
    state: startup.state,
    tls: startup.tls,
  })
)
if (initialPairing.kind === "automatic") {
  console.log(
    "Automatic Relay pairing is pending; the bootstrap token has been redacted."
  )
} else if (initialPairing.invitation) {
  console.log(renderPairingInvitation(initialPairing.invitation))
}
await lifecycle.initializeProxy(
  await loadStartupWebRoutes(),
  startupProxySettings
)
let tailscaleFirewallError: string | null = null
const reconcileTailscaleFirewalls = Effect.tryPromise({
  try: () => lifecycle.reconcileTailscaleStackFirewalls(),
  catch: (cause) => cause,
}).pipe(
  Effect.matchEffect({
    onFailure: (cause) =>
      Effect.sync(() => {
        const message = cause instanceof Error ? cause.message : "unknown error"
        if (message !== tailscaleFirewallError) {
          console.error(
            "Relay could not restore Tailscale forwarding rules",
            cause
          )
          tailscaleFirewallError = message
        }
      }),
    onSuccess: () =>
      Effect.sync(() => {
        if (tailscaleFirewallError) {
          console.log("Relay restored Tailscale forwarding rules")
          tailscaleFirewallError = null
        }
      }),
  })
)
await runRelayEffect(
  "relay.tailscale.reconcileFirewalls.initial",
  reconcileTailscaleFirewalls
)
const tailscaleFirewallFiber = forkRelayEffect(
  "relay.tailscale.reconcileFirewalls",
  Effect.sleep("10 seconds").pipe(
    Effect.andThen(reconcileTailscaleFirewalls),
    Effect.forever
  )
)
const instanceMutations = new Map<
  string,
  {
    references: number
    retainedInstance?: RelayInstance
    semaphore: Semaphore.Semaphore
  }
>()
const webRouteMutation = Semaphore.makeUnsafe(1)
const snapshotHub = new RelaySnapshotHub(relaySnapshot)
// Keep one shared snapshot sampler active so crash recovery does not depend on
// a Hearth control connection. Interactive readers reuse the same cached loop.
snapshotHub.subscribe(() => undefined, false)
const provisioningManager = await runRelayEffect(
  "relay.startup.provisioning",
  ProvisioningManager.make({
    lifecycle,
    refreshSnapshot: () => snapshotHub.refresh(),
  })
)
const provisioningFiber = forkRelayEffect(
  "relay.provisioning.worker",
  provisioningManager.run()
)
const backupManager = await runRelayEffect(
  "relay.startup.backups",
  BackupManager.make({
    config,
    databases,
    findInstance: (instanceId) => docker.findInstance(instanceId),
    isInstanceStopped: async (instanceId) => {
      const instance = (await docker.inspectInstances()).find(
        (candidate) => candidate.id === instanceId
      )
      return (
        instance?.observedState === "stopped" &&
        instance.desiredState === "stopped"
      )
    },
  })
)
const backupFiber = forkRelayEffect("relay.backups.worker", backupManager.run())
const scheduleManager = await ScheduleManager.make({
  enqueueBackup: (input) =>
    runRelayEffect(
      "relay.schedules.backup.enqueue",
      backupManager.enqueue(input)
    ),
  findInstance: (instanceId) => docker.findInstance(instanceId),
  forkEffect: (name, effect) => forkRelayEffect(name, effect),
  getBackup: (taskId) =>
    runRelayEffect("relay.schedules.backup.get", backupManager.get(taskId)),
  listDatabaseIds: async () =>
    new Set((await databases.list()).map((database) => database.id)),
  platformTargetId: config.installationId ?? relayIdentity.fingerprint,
  relayId: relayIdentity.fingerprint,
  reportError: (message, cause) => {
    Sentry.captureException(
      cause instanceof Error ? cause : new Error(message, { cause }),
      { tags: { "kiln.operation": "schedule.occurrence" } }
    )
  },
  runDatabasePower: async (databaseId, action) => {
    await databases.action({ action, databaseId })
  },
  runInstancePower: async (instanceId, action) => {
    const instance = await docker.findInstance(instanceId)
    if (!instance) throw new Error("Instance not found")
    const runAction = async () => {
      const [routes, pendingPrimaryPort] = await Effect.runPromise(
        Effect.all(
          [
            startup.state.listInstanceRoutes(instance.id),
            startup.state.getPendingPrimaryPort(instance.id),
          ] as const,
          { concurrency: 2 }
        )
      )
      await serializeInstanceMutation(instance.id, () =>
        lifecycle.runInstanceAction(
          instance,
          action,
          routes,
          pendingPrimaryPort
        )
      )
      await snapshotHub.refresh()
    }
    if (action === "start" || action === "restart") {
      await serializeWebRouteMutation(runAction)
    } else {
      await runAction()
    }
  },
  sendConsoleCommand: async (instanceId, command) => {
    const instance = await docker.findInstance(instanceId)
    if (!instance) throw new Error("Instance not found")
    await docker.sendCommand(instance, command)
  },
  stateDirectory: `${config.dataDirectory}/schedules`,
})
const scheduleFiber = forkRelayEffect(
  "relay.schedules.worker",
  scheduleManager.run()
)
const backupDownloads = new BackupDownloadServer({
  config,
  identity: relayIdentity,
  runEffect: (effect) => runRelayEffect("relay.backups.download", effect),
  state: startup.state,
})

async function loadStartupWebRoutes() {
  const { initialized, persisted } = await runRelayEffect(
    "relay.startup.webRoutes",
    Effect.gen(function* () {
      const initialized = yield* startup.state.getMetadata(
        WEB_ROUTE_RECOVERY_METADATA_KEY
      )
      const persisted = yield* startup.state.listWebRoutes()
      return { initialized, persisted }
    })
  )
  if (initialized) return persisted

  // Labels are a last-applied recovery snapshot, not a second live source of
  // truth. Only import them for a fresh database so stale labels cannot undo a
  // normal route edit that is still waiting for container recreation.
  const snapshots = await docker.webRouteLabelSnapshots()
  const plan = planWebRouteRecovery(persisted, snapshots)
  for (const warning of plan.warnings) {
    console.warn(`Skipped web route recovery label: ${warning}`)
  }
  await runRelayEffect(
    "relay.startup.webRouteRecovery",
    Effect.gen(function* () {
      for (const recovery of plan.recoveries) {
        yield* startup.state.replaceInstanceRoutes(
          recovery.instanceId,
          recovery.routes
        )
      }
      yield* startup.state.setMetadata(
        WEB_ROUTE_RECOVERY_METADATA_KEY,
        String(Date.now())
      )
    })
  )
  const recoveredCount = plan.recoveries.reduce(
    (count, recovery) => count + recovery.routes.length,
    0
  )
  if (recoveredCount > 0) {
    console.log(
      `Recovered ${recoveredCount} web route${recoveredCount === 1 ? "" : "s"} from Ember container labels.`
    )
  }
  return runRelayEffect(
    "relay.startup.webRoutes.recovered",
    startup.state.listWebRoutes()
  )
}

async function runRelayCli(arguments_: ReadonlyArray<string>): Promise<void> {
  const [resource, command = resource === "pair" ? "create" : "list"] =
    arguments_
  if (resource === "pair" && command === "create") {
    const role = arguments_.includes("--read-only")
      ? "read_only"
      : "full_access"
    const invitation = await runRelayEffect(
      "relay.cli.pair.create",
      Effect.gen(function* () {
        const created = yield* createPairingInvitation({
          config,
          identity: relayIdentity,
          role,
          state: startup.state,
          tls: startup.tls,
        })
        const initialized = yield* startup.state.getMetadata(
          "networking_initial_invitation"
        )
        if (!initialized) {
          yield* startup.state.setMetadata(
            "networking_initial_invitation",
            JSON.stringify({
              createdAt: Date.now(),
              invitationId: created.envelope.invitationId,
              kind: "cli",
            })
          )
        }
        return created
      })
    )
    console.log(renderPairingInvitation(invitation))
    console.log(
      `Created ${role} invitation ${invitation.envelope.invitationId}; its token was displayed only in this terminal.`
    )
    return
  }
  if (resource === "pair" && command === "list") {
    const invitations = await runRelayEffect(
      "relay.cli.pair.list",
      startup.state.listInvitations(Date.now())
    )
    console.log(
      JSON.stringify(
        invitations.map(
          ({ tokenHash: _tokenHash, ...invitation }) => invitation
        ),
        null,
        2
      )
    )
    return
  }
  if (resource === "pair" && command === "revoke") {
    const invitationId = requiredCliArgument(arguments_[2], "invitation ID")
    const revoked = await runRelayEffect(
      "relay.cli.pair.revoke",
      startup.state.revokeInvitation(invitationId, Date.now())
    )
    console.log(revoked ? `Revoked ${invitationId}` : "Invitation not found")
    return
  }
  if (resource === "hearth" && command === "list") {
    const clients = await runRelayEffect(
      "relay.cli.hearth.list",
      startup.state.listClients()
    )
    console.log(
      JSON.stringify(
        clients.map(({ publicKey: _publicKey, ...client }) => client),
        null,
        2
      )
    )
    return
  }
  if (resource === "hearth" && command === "revoke") {
    const clientId = requiredCliArgument(arguments_[2], "client ID")
    const revoked = await runRelayEffect(
      "relay.cli.hearth.revoke",
      startup.state.revokeClient(clientId, Date.now())
    )
    console.log(revoked ? `Revoked ${clientId}` : "Hearth client not found")
    return
  }
  if (resource === "platform-backup" && command === "inspect") {
    const source = requiredCliArgument(arguments_[2], "backup path")
    if (!config.platformBackupKey) {
      throw new Error("KILN_PLATFORM_BACKUP_KEY is not configured")
    }
    console.log(
      JSON.stringify(
        await inspectEncryptedPlatformBackup(config.platformBackupKey, source),
        null,
        2
      )
    )
    return
  }
  if (resource === "platform-backup" && command === "restore") {
    const source = requiredCliArgument(arguments_[2], "backup path")
    const confirmIndex = arguments_.indexOf("--confirm")
    const confirmedInstallationId = requiredCliArgument(
      confirmIndex === -1 ? undefined : arguments_[confirmIndex + 1],
      "--confirm installation ID"
    )
    const restored = await restoreEncryptedPlatformBackup(
      config,
      source,
      confirmedInstallationId
    )
    console.log(
      `Restored Kiln platform backup for ${restored.installationId}. Start Hearth and verify the installation before resuming operations.`
    )
    return
  }
  throw new Error(
    "Usage: kiln-relay pair create|list|revoke; kiln-relay hearth list|revoke; or kiln-relay platform-backup inspect|restore <path> [--confirm <installation-id>]"
  )
}

function requiredCliArgument(
  value: string | undefined,
  description: string
): string {
  if (!value?.trim()) throw new Error(`Missing ${description}`)
  return value.trim()
}

const requestHandler = (
  request: IncomingMessage,
  response: ServerResponse
): void => {
  Effect.runFork(
    relayOperation(async () => {
      if (healthCheck(request, response)) return
      if (trustProbe(request, response)) return
      if (bootstrapDiscovery(request, response)) return
      if (await pairingRequest(request, response)) return
      if (await backupDownloads.handleRequest(request, response)) return
      if (await browserSocket.handleRequest(request, response)) return
      json(response, 426, {
        error: "Relay control operations require a WebSocket transport",
        code: "websocket_required",
      })
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (cause instanceof RelayPairingError) {
            json(response, 401, { error: cause.message, code: cause.code })
            return
          }
          Sentry.captureException(cause, {
            tags: { "kiln.operation": normalizedRequestOperation(request.url) },
          })
          console.error(cause)
          json(response, 500, {
            error: cause.message,
            code: "internal_error",
          })
        })
      )
    )
  )
}

const server = activeTls
  ? createHttpsServer(
      { cert: activeTls.certificatePem, key: activeTls.keyPem },
      requestHandler
    )
  : createHttpServer(requestHandler)

const controlSocket = attachControlSocket({
  execute: executeControlRequest,
  identity: relayIdentity,
  initialSnapshot: () => snapshotHub.read(),
  runEffect: (effect) => runRelayEffect("relay.control.state", effect),
  server,
  state: startup.state,
  subscribeSnapshots: (listener) =>
    snapshotHub.subscribe(({ snapshot }) => listener(snapshot), false),
})
const browserSocket = attachBrowserSocket({
  docker,
  filesystem,
  identity: relayIdentity,
  runEffect: (effect) => runRelayEffect("relay.browser.state", effect),
  server,
  state: startup.state,
  subscribeSnapshots: (listener) => snapshotHub.subscribe(listener),
})
let startingSftpServer: Awaited<ReturnType<typeof attachSftpServer>> | null =
  null
const sftpServer = await Effect.runPromise(
  relayOperation(() =>
    attachSftpServer({
      clientActions: async (clientId) =>
        (
          await runRelayEffect(
            "relay.sftp.clientGrant",
            startup.state.findClientById(clientId)
          )
        )?.actions ?? [],
      config,
      control: controlSocket,
      docker,
    })
  ).pipe(
    Effect.tap((sftp) =>
      Effect.sync(() => {
        startingSftpServer = sftp
      })
    ),
    Effect.tap(() =>
      relayOperation(() => lifecycle.assertPrivateProxyListener())
    ),
    Effect.tap(() => listenRelayServerEffect(server, config.port, config.host)),
    Effect.onError(() =>
      Effect.sync(() => {
        tailscaleFirewallFiber.interruptUnsafe()
        backupFiber.interruptUnsafe()
        provisioningFiber.interruptUnsafe()
        scheduleFiber.interruptUnsafe()
        scheduleManager.close()
        lifecycle.close()
        snapshotHub.close()
      }).pipe(
        Effect.andThen(
          Effect.all(
            [
              cleanupOperation("control socket", () => controlSocket.close()),
              cleanupOperation("browser socket", () => browserSocket.close()),
              cleanupOperation("SFTP server", () =>
                startingSftpServer
                  ? startingSftpServer.close()
                  : Promise.resolve()
              ),
              cleanupOperation("Effect runtime", disposeRelayRuntime),
            ],
            { concurrency: 4, discard: true }
          )
        )
      )
    )
  )
)
startingSftpServer = null
console.log(
  `Relay ${relayIdentity.fingerprint} (${relayIdentity.name}) listening on ${activeTls ? "https" : "http"}://${config.host}:${config.port}`
)
console.log(
  `Discovering ${config.managedLabel} containers in ${config.rootDirectory}`
)
const tlsRefreshFiber = forkRelayEffect(
  "relay.tls.refreshLoop",
  tlsRefreshLoop()
)

let shutdownStarted = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shutdownStarted) return
    shutdownStarted = true
    void shutdownRelay(signal)
  })
}

async function pairingRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> {
  const method = request.method ?? "GET"
  const url = new URL(request.url ?? "/", "http://relay")
  if (method !== "POST" || url.pathname !== "/v1/pair") return false
  const result = await runRelayEffect(
    "relay.pairing.enroll",
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => readJson(request))
      const pairing = yield* decodePairingRequest(input)
      return yield* pairHearth({
        bootstrapToken: config.bootstrapToken,
        identity: relayIdentity,
        request: pairing,
        state: startup.state,
      })
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RelayPairingError
          ? cause
          : RelayPairingError.make({ code: "invalid_pairing_request", cause })
      )
    )
  )
  json(response, 201, result)
  return true
}

function trustProbe(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const method = request.method ?? "GET"
  const url = new URL(request.url ?? "/", "http://relay")
  if (
    url.pathname === "/v1/trust/ca.pem" &&
    (method === "GET" || method === "HEAD")
  ) {
    if (!activeTls?.caCertificatePem) {
      json(response, 404, { error: "Relay does not use a managed local CA" })
      return true
    }
    response
      .writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
        "Content-Disposition": "attachment; filename=kiln-relay-ca.pem",
        "Content-Length": String(Buffer.byteLength(activeTls.caCertificatePem)),
        "Content-Type": "application/x-pem-file",
        "X-Content-Type-Options": "nosniff",
      })
      .end(method === "HEAD" ? undefined : activeTls.caCertificatePem)
    return true
  }
  if (url.pathname !== "/v1/trust" || (method !== "GET" && method !== "HEAD")) {
    return false
  }
  response
    .writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    })
    .end(
      method === "HEAD"
        ? undefined
        : JSON.stringify({
            relayFingerprint: relayIdentity.fingerprint,
            relayName: relayIdentity.name,
            proxyMode: config.proxyMode,
            tlsFingerprint: activeTls?.fingerprint ?? null,
            version: 1,
          })
    )
  return true
}

function bootstrapDiscovery(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const method = request.method ?? "GET"
  const url = new URL(request.url ?? "/", "http://relay")
  if (url.pathname !== "/v1/bootstrap" || method !== "GET") return false
  const invitation = initialPairing.invitation
  const clientNonce = url.searchParams.get("nonce")
  if (
    initialPairing.kind !== "automatic" ||
    !invitation ||
    !config.bootstrapToken ||
    !clientNonce ||
    Buffer.from(clientNonce, "base64url").length < 16
  ) {
    json(response, 404, { error: "Automatic pairing is not available" })
    return true
  }
  const serverNonce = randomBytes(32).toString("base64url")
  const transcript = {
    clientNonce,
    controlEndpoint: invitation.envelope.controlEndpoint,
    expiresAt: invitation.envelope.expiresAt,
    invitationId: invitation.envelope.invitationId,
    relayFingerprint: invitation.envelope.relayFingerprint,
    relayPublicKeyPem: invitation.envelope.relayPublicKeyPem,
    serverNonce,
    tlsFingerprint:
      activeTls?.fingerprint ??
      (config.proxyMode === "coolify" || config.proxyMode === "traefik"
        ? "edge-terminated"
        : "development"),
  }
  const { token: _token, ...envelope } = invitation.envelope
  json(response, 200, {
    envelope,
    proof: createHmac("sha256", config.bootstrapToken)
      .update(relayBootstrapDiscoveryTranscript(transcript))
      .digest("base64url"),
    serverNonce,
    tlsFingerprint: transcript.tlsFingerprint,
  })
  return true
}

function tlsRefreshLoop() {
  if (!activeTls || !("setSecureContext" in server)) {
    return Effect.void
  }
  let nextDelay = activeTls.mode === "external" ? 60_000 : 6 * 60 * 60_000
  const recordFailure = (cause: unknown) =>
    Effect.sync(() => {
      Sentry.captureException(cause, {
        tags: { "kiln.operation": "relay.tls.refresh" },
      })
      console.error(
        "Relay TLS refresh failed; retaining the last valid certificate",
        cause
      )
      nextDelay = 60_000
    })
  return Effect.gen(function* () {
    yield* Effect.sleep(nextDelay)
    yield* loadRelayTls(config).pipe(
      Effect.matchEffect({
        onFailure: recordFailure,
        onSuccess: (material) => {
          if (!material) {
            return recordFailure(
              new Error("TLS mode changed while Relay was running")
            )
          }
          return Effect.sync(() => {
            if (material.fingerprint !== activeTls?.fingerprint) {
              server.setSecureContext({
                cert: material.certificatePem,
                key: material.keyPem,
              })
              console.log(
                `Relay TLS certificate reloaded (${material.fingerprint})`
              )
            }
            activeTls = material
            nextDelay = material.mode === "external" ? 60_000 : 6 * 60 * 60_000
          })
        },
      })
    )
  }).pipe(Effect.forever)
}

function shutdownRelay(signal: NodeJS.Signals): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        console.log(`Received ${signal}; shutting down relay`)
        tailscaleFirewallFiber.interruptUnsafe()
        tlsRefreshFiber.interruptUnsafe()
        backupFiber.interruptUnsafe()
        provisioningFiber.interruptUnsafe()
        scheduleFiber.interruptUnsafe()
        scheduleManager.close()
        lifecycle.close()
        snapshotHub.close()
      })
      yield* Effect.all(
        [
          cleanupOperation("control socket", () => controlSocket.close()),
          cleanupOperation("browser socket", () => browserSocket.close()),
          cleanupOperation("SFTP server", () => sftpServer.close()),
        ],
        { concurrency: 3, discard: true }
      )
      const result = yield* relayOperation(() =>
        closeRelayServer(server, new Set())
      ).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.error("Relay server shutdown failed", cause)
            return "forced" as const
          })
        )
      )
      if (result === "forced") {
        console.warn(
          "Relay shutdown deadline reached; closed active connections"
        )
      }
      yield* Effect.all(
        [
          cleanupOperation("Effect runtime", disposeRelayRuntime),
          cleanupOperation("Sentry", () => Sentry.close(2_000)),
        ],
        { concurrency: 2, discard: true }
      )
      yield* Effect.sync(() => process.exit(0))
    })
  )
}

async function relaySnapshot() {
  const [
    node,
    instances,
    storedNames,
    pendingPrimaryPorts,
    provisioningJobs,
    sftpPublication,
  ] = await Effect.runPromise(
    Effect.all(
      [
        relayOperation(() => nodeSnapshot(config, docker)),
        relayOperation(() => docker.inspectInstances()),
        relayOperation(() =>
          runRelayEffect(
            "relay.snapshot.instanceNames",
            startup.state.listInstanceNames()
          )
        ),
        relayOperation(() =>
          runRelayEffect(
            "relay.snapshot.pendingPrimaryPorts",
            startup.state.listPendingPrimaryPorts()
          )
        ),
        relayOperation(() =>
          runRelayEffect(
            "relay.snapshot.provisioningJobs",
            startup.state.listProvisioningJobs()
          )
        ),
        relayOperation(() => docker.relaySftpPublication(sftpServer.port)),
      ] as const,
      { concurrency: 4 }
    )
  )
  const visibleInstances = applyStoredPendingPrimaryPorts(
    applyStoredInstanceNames(instances, storedNames),
    pendingPrimaryPorts
  )
  const retainedInstances = Array.from(instanceMutations.values()).flatMap(
    (entry) => (entry.retainedInstance ? [entry.retainedInstance] : [])
  )
  const provisioningById = new Map(
    provisioningJobs.map((job) => [job.instanceId, job.placeholder])
  )
  const instancesWithProvisioning = visibleInstances.map((instance) => {
    const placeholder = provisioningById.get(instance.id)
    if (!placeholder) return instance
    provisioningById.delete(instance.id)
    return {
      ...instance,
      observedState: placeholder.observedState,
      provisioning: placeholder.provisioning,
      status: placeholder.status,
    }
  })
  return {
    node,
    instances: retainProvisioningInstances(
      [...instancesWithProvisioning, ...provisioningById.values()],
      retainedInstances
    ),
    relay: {
      id: relayIdentity.fingerprint,
      name: relayIdentity.name,
      sftp: {
        developmentAuthentication: config.sftpDevAuthentication,
        host: config.advertisedHost,
        hostKeyFingerprint: sftpServer.hostKeyFingerprint,
        port: sftpPublication.port,
        publication: sftpPublication.status,
      },
      tls: activeTls
        ? {
            expiresAt: activeTls.expiresAt,
            fingerprint: activeTls.fingerprint,
            mode: activeTls.mode,
          }
        : null,
    },
  }
}

async function executeControlRequest(
  request: RelayControlRequest,
  client: RelayClientGrant,
  signal: AbortSignal,
  requestHearth: (
    operation: RelayControlOperation,
    payload: unknown,
    timeoutMs: number
  ) => Promise<unknown>
): Promise<unknown> {
  if (signal.aborted) throw new Error("Relay request was cancelled")
  const payload = payloadRecord(request.payload)
  switch (request.operation) {
    case "relay.snapshot":
      return snapshotHub.read()
    case "relay.system.inspect":
      return runRelayEffect(
        "relay.systemUpdates.inspect",
        systemUpdates.inspect(
          typeof payload.container === "string" && payload.container.trim()
            ? payload.container
            : hostname()
        )
      )
    case "relay.update.apply": {
      const targetValues = Array.isArray(payload.targets)
        ? payload.targets
        : null
      const batched = targetValues !== null
      const operations = await runRelayEffect(
        "relay.systemUpdates.startBatch",
        systemUpdates.startBatch(
          {
            helperImage: requiredString(payload, "helperImage"),
            targets: targetValues
              ? targetValues.map(systemUpdateTarget)
              : [systemUpdateTarget(payload)],
          },
          signal
        )
      )
      await Promise.all(
        operations.map((operation) =>
          appendRelayAudit("system.update_started", client.id, request.id, {
            batchId: operation.batchId,
            component: operation.component,
            operationId: operation.id,
            targetContainer: operation.targetContainer,
            version: operation.version,
          })
        )
      )
      return batched ? operations : operations[0]
    }
    case "relay.update.status":
      return runRelayEffect(
        "relay.systemUpdates.status",
        systemUpdates.status(requiredString(payload, "operationId"))
      )
    case "relay.networking.read":
      return (await lifecycle.networking()) ?? null
    case "relay.networking.write":
      return lifecycle.configureNetworking(
        relayNetworkingSchema.parse(request.payload)
      )
    case "relay.tailscale.read":
      return lifecycle.tailscaleOverview()
    case "relay.tailscale.write":
      return lifecycle.configureTailscale(
        relayTailscaleSettingsSchema.parse(request.payload)
      )
    case "relay.tailscale.install":
      return lifecycle.installTailscale(
        relayTailscaleInstallSchema.parse(request.payload).authKey
      )
    case "relay.tailscale.stack.list":
      return lifecycle.tailscaleStacks()
    case "relay.tailscale.stack.apply": {
      const input = relayTailscaleStackApplySchema.parse(request.payload)
      const stack = await serializeInstanceMutation(input.id, () =>
        lifecycle.applyTailscaleStack(input)
      )
      await snapshotHub.refresh()
      return stack
    }
    case "relay.tailscale.stack.dns": {
      const input = relayTailscaleStackDnsSchema.parse(request.payload)
      return serializeInstanceMutation(input.id, () =>
        lifecycle.syncTailscaleStackDns(input)
      )
    }
    case "relay.tailscale.stack.remove": {
      const { controlPlaneDeviceRemoved, id, mode } =
        relayTailscaleStackRemoveSchema.parse(request.payload)
      await serializeInstanceMutation(id, () =>
        lifecycle.removeTailscaleStack(id, mode, controlPlaneDeviceRemoved)
      )
      if (mode === "commit") {
        await runRelayEffect(
          "relay.tailscale.stack.deleteName",
          startup.state.deleteInstanceName(id)
        )
      }
      await snapshotHub.refresh()
      return { mode, removed: mode === "commit" }
    }
    case "relay.proxy.read": {
      const settings = await lifecycle.proxySettings()
      return {
        diagnostics: await lifecycle.proxyDiagnostics(settings),
        settings,
      }
    }
    case "relay.proxy.write": {
      const settings = relayProxySettingsSchema.parse(request.payload)
      const routes = await runRelayEffect(
        "relay.proxy.routes",
        startup.state.listWebRoutes()
      )
      return lifecycle.configureProxy(settings, routes)
    }
    case "relay.audit.list":
      return runRelayEffect(
        "relay.control.audit.list",
        startup.state.listAudits(relayAuditQuerySchema.parse(payload))
      )
    case "relay.pairing.create": {
      const role = relayClientRole(payload.role)
      const customActions = relayActionSelection(payload.actions)
      const invitation = await runRelayEffect(
        "relay.control.pairing.create",
        createPairingInvitation({
          config,
          actions: customActions,
          identity: relayIdentity,
          role,
          state: startup.state,
          tls: activeTls,
        })
      )
      console.log(
        `Created pairing invitation ${invitation.envelope.invitationId}; its secret was returned only to the requesting Hearth.`
      )
      await appendRelayAudit("invitation.created", client.id, request.id, {
        invitationId: invitation.envelope.invitationId,
        role,
      })
      return invitation
    }
    case "relay.pairing.list": {
      const invitations = await runRelayEffect(
        "relay.control.pairing.list",
        startup.state.listInvitations(Date.now())
      )
      return invitations.map(
        ({ tokenHash: _tokenHash, ...invitation }) => invitation
      )
    }
    case "relay.pairing.revoke": {
      const invitationId = requiredString(payload, "invitationId")
      const revoked = await runRelayEffect(
        "relay.control.pairing.revoke",
        startup.state.revokeInvitation(invitationId, Date.now())
      )
      if (revoked) {
        await appendRelayAudit("invitation.revoked", client.id, request.id, {
          invitationId,
        })
      }
      return { invitationId, revoked }
    }
    case "relay.clients.list": {
      const clients = await runRelayEffect(
        "relay.control.clients.list",
        startup.state.listClients()
      )
      return clients.map(
        ({ publicKey: _publicKey, ...relayClient }) => relayClient
      )
    }
    case "relay.clients.update": {
      const clientId = requiredString(payload, "clientId")
      const role = relayClientRole(payload.role)
      const name = requiredString(payload, "name").trim()
      if (name.length > 120) throw new Error("Hearth name is too long")
      const sourceCidrs = normalizeSourceCidrs(payload.sourceCidrs ?? [])
      const actions = actionsForRole(
        role,
        relayActionSelection(payload.actions)
      )
      const updated = await runRelayEffect(
        "relay.control.clients.update",
        startup.state.updateClient({
          actions,
          clientId,
          name,
          role,
          sourceCidrs,
        })
      )
      if (updated) {
        await appendRelayAudit("client.policy_changed", client.id, request.id, {
          clientId,
          role,
          sourceCidrs,
        })
        browserSocket.revokeClient(clientId)
        scheduleClientReconnect(clientId)
      }
      return { actions, clientId, role, updated }
    }
    case "relay.clients.revoke": {
      const clientId = requiredString(payload, "clientId")
      const revoked = await runRelayEffect(
        "relay.control.clients.revoke",
        startup.state.revokeClient(clientId, Date.now())
      )
      if (revoked) {
        await appendRelayAudit("client.revoked", client.id, request.id, {
          clientId,
        })
        browserSocket.revokeClient(clientId)
        scheduleClientRevocation(clientId)
      }
      return { clientId, revoked }
    }
    case "brick.catalog":
      return bricks.catalog()
    case "brick.recipe":
      return {
        ...(await bricks.recipe(
          requiredString(payload, "source"),
          optionalString(payload, "snapshotSha256")
        )),
        source: requiredString(payload, "source"),
      }
    case "database.list":
      return databases.list()
    case "database.create":
      return databases.create(relayCreateDatabaseSchema.parse(request.payload))
    case "database.delete":
      return databases.delete(relayDeleteDatabaseSchema.parse(request.payload))
    case "database.action":
      return databases.action(relayDatabaseActionSchema.parse(request.payload))
    case "database.credentials.rotate":
      return databases.rotateCredentials(
        relayRotateDatabaseCredentialsSchema.parse(request.payload)
      )
    case "database.network.write":
      return databases.updateNetwork(
        relayDatabaseNetworkSchema.parse(request.payload)
      )
    case "database.dump.export":
      return databases.exportDump(
        relayDatabaseExportSchema.parse(request.payload)
      )
    case "database.dump.import":
      return databases.importDump(
        relayDatabaseDumpSchema.parse(request.payload)
      )
    case "backup.task.enqueue":
      return runRelayEffect(
        "relay.backups.enqueue",
        backupManager
          .enqueue(backupTaskInputSchema.parse(request.payload))
          .pipe(Effect.map(redactRelayBackupTask))
      )
    case "backup.task.cancel":
      return runRelayEffect(
        "relay.backups.cancel",
        backupManager
          .cancel(backupTaskIdSchema.parse(requiredString(payload, "taskId")))
          .pipe(
            Effect.map((task) => (task ? redactRelayBackupTask(task) : task))
          )
      )
    case "backup.task.get":
      return runRelayEffect(
        "relay.backups.get",
        backupManager
          .get(backupTaskIdSchema.parse(requiredString(payload, "taskId")))
          .pipe(
            Effect.map((task) => (task ? redactRelayBackupTask(task) : task))
          )
      )
    case "backup.task.list": {
      const updatedAfter = payload.updatedAfter
      if (
        updatedAfter !== undefined &&
        (!Number.isSafeInteger(updatedAfter) || Number(updatedAfter) < 0)
      ) {
        throw new Error("updatedAfter must be a non-negative integer")
      }
      return runRelayEffect(
        "relay.backups.list",
        backupManager
          .list(updatedAfter === undefined ? undefined : Number(updatedAfter))
          .pipe(Effect.map((tasks) => tasks.map(redactRelayBackupTask)))
      )
    }
    case "schedule.apply":
      return scheduleManager.apply(
        relayScheduleProjectionSchema.parse(request.payload)
      )
    case "schedule.run":
      return scheduleManager.runNow({
        revision: requiredPositiveInteger(payload, "revision"),
        scheduleId: requiredString(payload, "scheduleId"),
      })
    case "schedule.remove":
      return scheduleManager.remove({
        revision: requiredPositiveInteger(payload, "revision"),
        scheduleId: requiredString(payload, "scheduleId"),
      })
    case "schedule.overview": {
      const scheduleIds = Array.isArray(payload.scheduleIds)
        ? payload.scheduleIds.map((value) => {
            if (typeof value !== "string") {
              throw new Error("scheduleIds must contain strings")
            }
            return value
          })
        : undefined
      return scheduleManager.overview(scheduleIds)
    }
    case "instance.create": {
      if (!config.canProvisionInstances) {
        throw new Error("New server provisioning is disabled on this Relay")
      }
      const input = relayCreateInstanceSchema.parse(request.payload)
      const instance = await lifecycle.createInstance(input)
      const name = input.name ?? instance.name
      await Effect.runPromise(
        relayOperation(() =>
          runRelayEffect(
            "relay.instance.createName",
            startup.state.setInstanceName(instance.id, name)
          )
        ).pipe(
          Effect.onError(() =>
            Effect.all(
              [
                cleanupOperation("instance create", () =>
                  lifecycle.deleteInstance(instance.id, true)
                ),
                cleanupOperation("instance name", () =>
                  runRelayEffect(
                    "relay.instance.createName.rollback",
                    startup.state.deleteInstanceName(instance.id)
                  )
                ),
              ],
              { concurrency: 2, discard: true }
            )
          )
        )
      )
      return refreshRelayInstance(instance)
    }
    case "instance.provision.prepare": {
      if (!config.canProvisionInstances) {
        throw new Error("New server provisioning is disabled on this Relay")
      }
      const prepared = relayPrepareInstanceSchema.parse(request.payload)
      const { idempotencyKey, instanceId, ...input } = prepared
      const placeholder = await lifecycle.prepareInstance(instanceId, input)
      return runRelayEffect(
        "relay.instance.provision.prepare",
        provisioningManager.prepare({
          idempotencyKey,
          input,
          instanceId,
          placeholder,
        })
      )
    }
    case "instance.provision.claim": {
      const { instanceId } = relayProvisionInstanceSchema.parse(request.payload)
      return runRelayEffect(
        "relay.instance.provision.claim",
        provisioningManager.claim(instanceId)
      )
    }
    case "instance.provision.cancel": {
      const { instanceId } = relayProvisionInstanceSchema.parse(request.payload)
      const cancelled = await runRelayEffect(
        "relay.instance.provision.cancel",
        provisioningManager.cancel(instanceId)
      )
      return { cancelled, instanceId }
    }
    case "instance.startup.write": {
      const instanceId = requiredString(payload, "instanceId")
      const input = relayUpdateInstanceStartupSchema.parse(payload)
      const existing =
        (await snapshotHub.read()).instances.find(
          (candidate) => candidate.id === instanceId
        ) ?? relayInstanceSchema.parse(await requiredInstance(payload))
      return serializeInstanceMutation(
        instanceId,
        async () => {
          const instance = await lifecycle.reconfigureInstance(
            instanceId,
            input
          )
          return relayInstanceWithStoredName(instance)
        },
        existing
      )
    }
    case "instance.rename": {
      const instance = await requiredInstance(payload)
      const name = relayInstanceNameSchema.parse(payload.name)
      return serializeInstanceMutation(instance.id, async () => {
        await runRelayEffect(
          "relay.instance.rename",
          startup.state.setInstanceName(instance.id, name)
        )
        const snapshot = await snapshotHub.refresh()
        return (
          snapshot.instances.find(
            (candidate) => candidate.id === instance.id
          ) ?? { ...instance, name }
        )
      })
    }
    case "instance.delete": {
      const instanceId = requiredString(payload, "instanceId")
      const provisioningJob = await runRelayEffect(
        "relay.instance.provision.readForDelete",
        startup.state.getProvisioningJob(instanceId)
      )
      if (provisioningJob) {
        const cancelled = await runRelayEffect(
          "relay.instance.provision.cancelForDelete",
          provisioningManager.cancel(instanceId)
        )
        if (!cancelled) {
          throw new Error(
            "Wait for server provisioning to finish before deleting it"
          )
        }
        if (
          provisioningJob.status === "failed" &&
          (await docker.findInstance(instanceId))
        ) {
          await serializeInstanceMutation(instanceId, () =>
            lifecycle.deleteInstance(instanceId, payload.deleteData === true)
          )
        } else {
          await lifecycle.deletePreparedInstance(
            instanceId,
            payload.deleteData === true
          )
        }
        await runRelayEffect(
          "relay.instance.deletePreparedName",
          startup.state.deleteInstanceName(instanceId)
        )
        return { deleted: true, instanceId }
      }
      await serializeInstanceMutation(instanceId, () =>
        lifecycle.deleteInstance(
          instanceId,
          payload.deleteData === true,
          async ({ mode, stackIds }) => {
            await requestHearth(
              "hearth.tailscale.instance.detach",
              { instanceId, mode, stackIds },
              60_000
            )
          }
        )
      )
      await runRelayEffect(
        "relay.instance.deleteName",
        startup.state.deleteInstanceName(instanceId)
      )
      await runRelayEffect(
        "relay.instance.deletePendingPrimaryPort",
        startup.state.deletePendingPrimaryPort(instanceId)
      )
      await serializeWebRouteMutation(async () => {
        await runRelayEffect(
          "relay.network.routes.deleteInstance",
          startup.state.replaceInstanceRoutes(instanceId, [])
        )
        await lifecycle.configureWebRoutes(
          await runRelayEffect(
            "relay.network.routes.afterDelete",
            startup.state.listWebRoutes()
          )
        )
      })
      return { deleted: true, instanceId }
    }
    case "instance.action": {
      const instance = await requiredInstance(payload)
      const retainedInstance =
        (await snapshotHub.read()).instances.find(
          (candidate) => candidate.id === instance.id
        ) ?? relayInstanceSchema.parse(instance)
      const input = relayInstanceActionSchema.parse(payload)
      const runAction = () =>
        serializeInstanceMutation(
          instance.id,
          async () => {
            const [routes, pendingPrimaryPort] = await Effect.runPromise(
              Effect.all(
                [
                  relayOperation(() =>
                    runRelayEffect(
                      "relay.network.routes.forAction",
                      startup.state.listInstanceRoutes(instance.id)
                    )
                  ),
                  relayOperation(() =>
                    runRelayEffect(
                      "relay.instance.pendingPrimaryPort.forAction",
                      startup.state.getPendingPrimaryPort(instance.id)
                    )
                  ),
                ] as const,
                { concurrency: 2 }
              )
            )
            const updated = await lifecycle.runInstanceAction(
              instance,
              input.action,
              routes,
              pendingPrimaryPort
            )
            if (
              pendingPrimaryPort &&
              (input.action === "start" || input.action === "restart") &&
              updated.ports.some((allocation) => allocation.kind === "primary")
            ) {
              await runRelayEffect(
                "relay.instance.pendingPrimaryPort.applied",
                startup.state.deletePendingPrimaryPort(instance.id)
              )
            }
            return relayInstanceWithStoredName(updated)
          },
          retainedInstance
        )
      const updated =
        input.action === "start" || input.action === "restart"
          ? await serializeWebRouteMutation(runAction)
          : await runAction()
      return updated
    }
    case "instance.resources.read": {
      const instanceId = requiredString(payload, "instanceId")
      const instance = (await snapshotHub.read()).instances.find(
        (candidate) => candidate.id === instanceId
      )
      if (!instance) throw new Error("Instance not found")
      return {
        history: docker.resourceHistory(instance.id),
        instance,
      }
    }
    case "instance.files.list":
      return runRelayEffect(
        "relay.files.tree",
        filesystem.tree(await requiredInstance(payload))
      )
    case "instance.files.directory.list": {
      const input = relayDirectoryPageInputSchema.parse(payload)
      return runRelayEffect(
        "relay.files.directory",
        filesystem.directory(await requiredInstance(input), input)
      )
    }
    case "instance.files.search": {
      const input = relayFileSearchPageInputSchema.parse(payload)
      return runRelayEffect(
        "relay.files.search",
        filesystem.search(await requiredInstance(input), input)
      )
    }
    case "instance.files.stat": {
      const input = relayFileStatInputSchema.parse(payload)
      return runRelayEffect(
        "relay.files.stat",
        filesystem.entry(await requiredInstance(input), input.path)
      )
    }
    case "instance.files.read":
      return runRelayEffect(
        "relay.files.read",
        filesystem.read(
          await requiredInstance(payload),
          requiredString(payload, "path")
        )
      )
    case "instance.files.write": {
      const instance = await requiredInstance(payload)
      const input = relaySaveFileInputSchema.parse(payload)
      return serializeInstanceMutation(instance.id, () =>
        runRelayEffect(
          "relay.files.write",
          filesystem.write(instance, requiredString(payload, "path"), input)
        )
      )
    }
    case "instance.files.upload-url": {
      const input = relayRemoteFileUploadSchema.parse(request.payload)
      const instance = await requiredInstance(input)
      return serializeInstanceMutation(instance.id, () =>
        runRelayEffect(
          "relay.files.uploadUrl",
          withRemoteFileSource(input.url, (source) =>
            filesystem
              .upload(instance, input.path, source)
              .pipe(Effect.map(relayRemoteFileUploadResultSchema.parse))
          )
        )
      )
    }
    case "instance.files.mutate": {
      const instance = await requiredInstance(payload)
      const input = relayFileMutationInputSchema.parse(payload)
      return serializeInstanceMutation(instance.id, () =>
        runRelayEffect(
          "relay.files.mutate.legacy",
          filesystem
            .mutate(instance, input)
            .pipe(Effect.andThen(filesystem.tree(instance)))
        )
      )
    }
    case "instance.files.mutate.result": {
      const instance = await requiredInstance(payload)
      const input = relayFileMutationInputSchema.parse(payload)
      return serializeInstanceMutation(instance.id, () =>
        runRelayEffect("relay.files.mutate", filesystem.mutate(instance, input))
      )
    }
    case "instance.console.history":
      return docker.console(
        await requiredInstance(payload),
        typeof payload.limit === "number" ? payload.limit : 2_000
      )
    case "instance.console.write": {
      const instance = await requiredInstance(payload)
      const input = relayConsoleCommandSchema.parse(payload)
      await docker.sendCommand(instance, input.command)
      return { accepted: true, command: input.command }
    }
    case "instance.console.complete": {
      const instance = await requiredInstance(payload)
      const input = relayConsoleCompletionInputSchema.parse(payload)
      return docker.completeCommand(instance, input.input, input.cursor)
    }
    case "instance.logs.share": {
      const instance = await requiredInstance(payload)
      const input = relayConsoleShareInputSchema.parse(payload)
      const log = await docker.consoleLog(instance)
      return runRelayEffect(
        "mclogs.upload",
        uploadConsoleLogToMclogs(config.mclogsApiUrl, log, input)
      )
    }
    case "instance.logs.latest":
      return runRelayEffect(
        "relay.files.latestLog",
        filesystem.latestLog(await requiredInstance(payload))
      )
    case "instance.network.ports.reserve": {
      const instance = await requiredInstance(payload)
      const input = relayInstancePortLeaseRequestSchema.parse({
        externalPort: payload.externalPort,
        leaseId: payload.leaseId,
        overridePortRange: payload.overridePortRange,
        protocol: payload.protocol,
      })
      return runRelayEffect(
        "relay.ports.reserve",
        lifecycle.reserveInstancePortEffect(instance.id, input)
      )
    }
    case "instance.network.ports.release": {
      const instance = await requiredInstance(payload)
      const input = relayInstancePortLeaseReleaseSchema.parse({
        leaseId: payload.leaseId,
      })
      await runRelayEffect(
        "relay.ports.release",
        lifecycle.releaseInstancePortEffect(instance.id, input.leaseId)
      )
      return { released: true }
    }
    case "instance.network.ports.write": {
      return serializeWebRouteMutation(async () => {
        const instance = await requiredInstance(payload)
        const retainedInstance =
          (await snapshotHub.read()).instances.find(
            (candidate) => candidate.id === instance.id
          ) ?? relayInstanceSchema.parse(instance)
        const ports = relayInstancePortInputsSchema.parse(payload.ports)
        const routes = await runRelayEffect(
          "relay.network.ports.routes",
          startup.state.listInstanceRoutes(instance.id)
        )
        return serializeInstanceMutation(
          instance.id,
          async () => {
            const updated = await lifecycle.updateInstancePorts(
              instance.id,
              ports,
              routes
            )
            if (updated.pendingPrimaryPort) {
              await runRelayEffect(
                "relay.instance.pendingPrimaryPort.set",
                startup.state.setPendingPrimaryPort(
                  instance.id,
                  updated.pendingPrimaryPort
                )
              )
            } else {
              await runRelayEffect(
                "relay.instance.pendingPrimaryPort.clear",
                startup.state.deletePendingPrimaryPort(instance.id)
              )
            }
            return relayInstanceWithStoredName(updated)
          },
          retainedInstance
        )
      })
    }
    case "instance.network.routes.read": {
      const instance = await requiredInstance(payload)
      const routes = await runRelayEffect(
        "relay.network.routes.read",
        startup.state.listInstanceRoutes(instance.id)
      )
      return lifecycle.webRouteState(instance.id, routes)
    }
    case "instance.network.routes.write": {
      return serializeWebRouteMutation(async () => {
        const instance = await requiredInstance(payload)
        const requestedRoutes = relayInstanceWebRouteInputsSchema.parse(
          payload.routes
        )
        const configuredRoutes = await runRelayEffect(
          "relay.network.routes.collisionCheck",
          startup.state.listWebRoutes()
        )
        const routes = assignRelayWebRouteIds(
          instance.id,
          requestedRoutes,
          configuredRoutes
        )
        const collision = routes.find((route) =>
          configuredRoutes.some(
            (configured) =>
              configured.instanceId !== instance.id &&
              configured.hostname === route.hostname &&
              configured.path === route.path
          )
        )
        if (collision) {
          throw new Error(
            `Another Ember already uses https://${collision.hostname}${collision.path ?? ""}. Hostname and path routes must be unique on a Relay.`
          )
        }
        const previous = await runRelayEffect(
          "relay.network.routes.previous",
          startup.state.listInstanceRoutes(instance.id)
        )
        await runRelayEffect(
          "relay.network.routes.replace",
          startup.state.replaceInstanceRoutes(instance.id, routes)
        )
        await Effect.runPromise(
          relayOperation(async () => {
            const allRoutes = await runRelayEffect(
              "relay.network.routes.all",
              startup.state.listWebRoutes()
            )
            await lifecycle.configureWebRoutes(allRoutes)
          }).pipe(
            Effect.onError(() =>
              cleanupOperation("web route rollback", async () => {
                await runRelayEffect(
                  "relay.network.routes.rollback",
                  startup.state.replaceInstanceRoutes(instance.id, previous)
                )
                await lifecycle.configureWebRoutes(
                  await runRelayEffect(
                    "relay.network.routes.rollbackAll",
                    startup.state.listWebRoutes()
                  )
                )
              })
            )
          )
        )
        return lifecycle.webRouteState(instance.id, routes)
      })
    }
    case "relay.rename": {
      relayIdentity = await runRelayEffect(
        "relay.control.rename",
        renameRelayIdentity(
          config,
          relayIdentity,
          requiredString(payload, "name")
        )
      )
      config.nodeName = relayIdentity.name
      config.nodeId = relayIdentity.fingerprint
      await snapshotHub.refresh()
      await appendRelayAudit("relay.renamed", client.id, request.id, {
        name: relayIdentity.name,
      })
      return { id: relayIdentity.fingerprint, name: relayIdentity.name }
    }
    case "sftp.authorization.resolve":
      throw new Error(`${request.operation} is not available yet`)
  }
}

function relayClientRole(value: unknown): RelayClientRole {
  if (value === "full_access" || value === "read_only" || value === "custom") {
    return value
  }
  throw new Error("Relay client role is invalid")
}

function relayActionSelection(value: unknown): ReadonlyArray<RelayAction> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > relayActions.length) {
    throw new Error("Relay client actions are invalid")
  }
  const selected = new Set(value)
  if ([...selected].some((action) => typeof action !== "string")) {
    throw new Error("Relay client actions are invalid")
  }
  return relayActions.filter((action) => selected.has(action))
}

async function appendRelayAudit(
  event: string,
  clientId: string | null,
  requestId: string | null,
  details: Readonly<Record<string, unknown>>
): Promise<void> {
  await runRelayEffect(
    `relay.audit.${event}`,
    startup.state.appendAudit({
      clientId,
      details,
      event,
      id: randomUUID(),
      occurredAt: Date.now(),
      requestId,
    })
  )
}

function scheduleClientReconnect(clientId: string): void {
  Effect.runFork(
    Effect.sleep("25 millis").pipe(
      Effect.andThen(Effect.sync(() => controlSocket.refreshClient(clientId)))
    )
  )
}

function scheduleClientRevocation(clientId: string): void {
  Effect.runFork(
    Effect.sleep("25 millis").pipe(
      Effect.andThen(Effect.sync(() => controlSocket.revokeClient(clientId)))
    )
  )
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay request payload must be an object")
  }
  return Object.fromEntries(Object.entries(value))
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string
): string {
  const field = value[key]
  if (typeof field !== "string" || !field) {
    throw new Error(`${key} is required`)
  }
  return field
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const field = value[key]
  return typeof field === "string" && field ? field : undefined
}

function requiredPositiveInteger(
  value: Readonly<Record<string, unknown>>,
  key: string
): number {
  const field = value[key]
  if (!Number.isSafeInteger(field) || Number(field) <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return Number(field)
}

function systemUpdateTarget(value: unknown): {
  targetContainer: string
  targetImage: string
  version: string
} {
  const target = payloadRecord(value)
  return {
    targetContainer: requiredString(target, "targetContainer"),
    targetImage: requiredString(target, "targetImage"),
    version: requiredString(target, "version"),
  }
}

async function requiredInstance(payload: Readonly<Record<string, unknown>>) {
  const instanceId = requiredString(payload, "instanceId")
  const instance = await docker.findInstance(instanceId)
  if (!instance) throw new Error("Instance not found")
  return instance
}

async function relayInstanceWithStoredName(instance: RelayInstance) {
  const [names, pendingPrimaryPorts] = await Effect.runPromise(
    Effect.all(
      [
        relayOperation(() =>
          runRelayEffect(
            "relay.instance.name",
            startup.state.listInstanceNames()
          )
        ),
        relayOperation(() =>
          runRelayEffect(
            "relay.instance.pendingPrimaryPort",
            startup.state.listPendingPrimaryPorts()
          )
        ),
      ] as const,
      { concurrency: 2 }
    )
  )
  return (
    applyStoredPendingPrimaryPorts(
      applyStoredInstanceNames([instance], names),
      pendingPrimaryPorts
    )[0] ?? instance
  )
}

async function refreshRelayInstance(instance: RelayInstance) {
  const updated = await relayInstanceWithStoredName(instance)
  await snapshotHub.refresh()
  return updated
}

function applyStoredPendingPrimaryPorts(
  instances: ReadonlyArray<RelayInstance>,
  pendingPrimaryPorts: ReadonlyArray<RelayStoredPendingPrimaryPort>
): Array<RelayInstance> {
  const pendingByInstanceId = new Map(
    pendingPrimaryPorts.map(({ instanceId, ...port }) => [instanceId, port])
  )
  return instances.map((instance) => {
    if (instance.ports.some((allocation) => allocation.kind === "primary")) {
      return instance
    }
    const pendingPrimaryPort = pendingByInstanceId.get(instance.id)
    return pendingPrimaryPort ? { ...instance, pendingPrimaryPort } : instance
  })
}

function serializeInstanceMutation<T>(
  instanceId: string,
  mutate: () => Promise<T>,
  retainedInstance?: RelayInstance
): Promise<T> {
  let entry = instanceMutations.get(instanceId)
  if (!entry) {
    entry = { references: 0, semaphore: Semaphore.makeUnsafe(1) }
    instanceMutations.set(instanceId, entry)
  }
  entry.references += 1
  const activeEntry = entry
  const operation = relayOperation(async () => {
    if (retainedInstance) activeEntry.retainedInstance = retainedInstance
    return mutate()
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (activeEntry.retainedInstance === retainedInstance) {
          delete activeEntry.retainedInstance
        }
      }).pipe(
        Effect.andThen(
          retainedInstance
            ? cleanupOperation("instance mutation snapshot", () =>
                snapshotHub.refresh()
              )
            : Effect.void
        )
      )
    )
  )
  return Effect.runPromise(
    activeEntry.semaphore.withPermit(operation).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          activeEntry.references -= 1
          if (
            activeEntry.references === 0 &&
            instanceMutations.get(instanceId) === activeEntry
          ) {
            instanceMutations.delete(instanceId)
          }
        })
      )
    )
  )
}

function serializeWebRouteMutation<T>(mutate: () => Promise<T>): Promise<T> {
  return Effect.runPromise(webRouteMutation.withPermit(relayOperation(mutate)))
}

function normalizedRequestOperation(url: string | undefined): string {
  return normalizedRoute(new URL(url ?? "/", "http://relay").pathname)
}

function healthCheck(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const method = request.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") return false
  const url = new URL(request.url ?? "/", "http://relay")
  if (url.pathname !== "/health") return false
  response.writeHead(204, { "Cache-Control": "no-store" }).end()
  return true
}

function listenRelayServerEffect(
  relayServer: HttpServer,
  port: number,
  host: string
): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const failed = (cause: Error) => {
      resume(Effect.fail(cause))
    }
    relayServer.once("error", failed)
    relayServer.listen(port, host, () => {
      relayServer.off("error", failed)
      resume(Effect.void)
    })
    return Effect.sync(() => {
      relayServer.off("error", failed)
      if (relayServer.listening) relayServer.close()
    })
  })
}

function cleanupOperation(
  name: string,
  run: () => Promise<unknown>
): Effect.Effect<void> {
  return relayOperation(run).pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.sync(() => {
        Sentry.captureException(cause, {
          tags: { "kiln.operation": "relay.cleanup", "kiln.resource": name },
        })
        console.error(`Relay ${name} cleanup failed`, cause)
      })
    )
  )
}

function relayOperation<TResult>(
  run: () => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Relay operation failed"),
  })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > 2 * 1024 * 1024) throw new Error("Request body is too large")
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString("utf8")
  return body ? (JSON.parse(body) as unknown) : {}
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  })
  response.end(JSON.stringify(value))
}
