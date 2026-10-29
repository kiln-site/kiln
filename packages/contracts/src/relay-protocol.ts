import { Schema } from "effect"

export const relayControlProtocol = "kiln-relay.v1" as const
// Release compatibility level for response-shape changes. Keep this separate
// from the WebSocket subprotocol so Hearth can be upgraded before Relay.
export const relayControlProtocolVersion = 8 as const
export const relayBrowserProtocol = "kiln-relay-browser.v1" as const
export const relayBrowserConsoleProtocol = "kiln-relay-browser.v2" as const
export const relayBrowserConsoleProtocols = [
  relayBrowserConsoleProtocol,
  relayBrowserProtocol,
] as const
export const relayBrowserMaxFrameBytes = 256 * 1024
// Shared safety cap for relay<->hearth control frames. File listings and
// search results are paged well below this boundary.
export const relayControlMaxFrameBytes = 1024 * 1024
export const relayPairingProtocol = "kiln-relay-pair.v1" as const
export const relayAuthenticationWindowMs = 10_000
export const relayBrowserCapabilityV2Feature = "browser-capability-v2"
export const relayBrowserLeaseRenewalV1Feature = "browser-lease-renewal-v1"
export const relayFileRequestReplayV1Feature = "file-request-replay-v1"
// The Relay streams console output for more kinds of resource than servers;
// see `relayBrowserResourceKinds`.
export const relayConsoleResourcesV1Feature = "console-resources-v1"
// The Relay deploys apps: Docker images, Dockerfiles, and Compose projects.
export const relayAppsV1Feature = "apps-v1"
// The Relay serves its host's files under its own ID as a file root.
export const relayHostFilesV1Feature = "relay-host-files-v1"
// The Relay streams its own container's output as the `relay` console kind.
export const relayLogsV1Feature = "relay-logs-v1"
// The Relay answers `relay.proxy.config.read` with its proxy configuration.
export const relayProxyConfigurationV1Feature = "relay-proxy-configuration-v1"
// The Relay restarts its own container (`relay.restart`) and its host
// (`relay.host.restart`).
export const relayRestartV1Feature = "relay-restart-v1"
// The Relay reports its own usage in `node.relayResources`, and its recent
// samples through `relay.resources.read`.
export const relayResourcesV1Feature = "relay-resources-v1"
// Hearth reads `errorCode` on backup tasks and their artifact outcomes, so
// the Relay may send it.
export const relayBackupFailureCodesV1Feature = "backup-failure-codes-v1"
// The Relay answers `instance.files.put`, creating or replacing one file.
export const relayFilePutV1Feature = "files-put-v1"
// The Relay applies memory, CPU, and disk limits from a request's `limits`,
// where `null` means no limit.
export const relayResourceLimitsV1Feature = "resource-limits-v1"
// The Relay answers `database.limits.write` and reports databases' limits.
export const relayDatabaseLimitsV1Feature = "database-limits-v1"
// The Relay applies app configs' `serviceLimits`, and
// answers `app.limits.write`.
export const relayAppLimitsV1Feature = "app-limits-v1"
// The Relay provisions databases in the background through
// `database.provision.*`, showing a placeholder until each one exists.
export const relayDatabaseProvisioningV1Feature = "database-provisioning-v1"
// The Relay provisions apps through `app.provision.*` the same way.
export const relayAppProvisioningV1Feature = "app-provisioning-v1"
// The Relay deploys GitHub sources from `app.deploy`'s `github` checkout,
// rolls deployments over once their containers are healthy, and answers
// `app.deployment.read`.
export const relayAppGitHubV1Feature = "app-github-v1"
// The Relay lists, creates, renames, and deletes its Docker named volumes
// through `relay.volumes.*`.
export const relayVolumesV1Feature = "relay-volumes-v1"
// The Relay answers `app.image.check`, and deploys an image app at the
// digest `app.deploy`'s `imageDigest` names.
export const relayAppImageUpdatesV1Feature = "app-image-updates-v1"
// The Relay reports the Kiln services on its Docker host (Hearth, its
// database, and its cache) through `relay.platform.*`, and, when it installed
// them itself, restarts and repairs them.
export const relayPlatformV1Feature = "relay-platform-v1"
// The Relay also reports the Traefik in front of Hearth, follows each of
// Kiln's containers' output as browser resource `platform`, opens shells in
// them through `relay.platform.terminal.*`, and restarts its own Traefik.
export const relayPlatformV2Feature = "relay-platform-v2"
// The Relay browses and edits Hearth's own database through
// `relay.platform.database.*`, with the credentials Hearth sends.
export const relayPlatformDatabaseV1Feature = "relay-platform-database-v1"
// Database dumps travel as files under the database's file root
// (`database:<id>`): `database.dump.export` writes `export` there for the
// browser to download, and `database.dump.import` runs the file the browser
// uploaded, which each import names for itself (`import-<random>`).
export const relayDatabaseDumpFilesV1Feature = "database-dump-files-v1"
export const relayDatabaseDumpExportFile = "export"
// Reads and replaces the Relay's Kiln installation ID
// (`relay.installation.read`, `relay.installation.replace`). Relays with it
// adopt an ID from Hearth's authentication only when they have none.
export const relayInstallationV1Feature = "relay-installation-v1"
// The Relay lists what runs on its host (`relay.security.targets`) and
// inventories its host and images with Syft (`relay.security.inventory`),
// so Hearth can check them for known vulnerabilities.
export const relaySecurityInventoryV1Feature = "security-inventory-v1"
// Web routes take a www counterpart, plain HTTP, a primary flag, an optional
// label, and redirects to another URL. Older Relays need a name and a port
// on every route.
export const relayWebRouteOptionsV1Feature = "web-route-options-v1"
// The Relay answers `instance.icon.read` with a small image's bytes, from a
// file root or from inside one of an app's containers.
export const relayIconReadV1Feature = "icon-read-v1"
// The Relay opens its control connection to Hearth when Hearth asks it to
// (`auth.response`'s `dial`), as well as answering Hearth's.
export const relayControlDialV1Feature = "control-dial-v1"
// Where on Hearth a Relay opens its control connection.
export const relayControlDialPath = "/api/relays/control"
// The Relay opens a tunnel to its own listener on request
// (`relay.tunnel.open`), so Hearth can reach a Relay that dials it.
export const relayTunnelV1Feature = "tunnel-v1"
// Where on Hearth a Relay opens those tunnels, and their subprotocol. The
// upgrade names the tunnel with the token Hearth asked for it with
// (`relayTunnelTokenHeader`), so Hearth turns away any other before taking
// it; every frame is bytes to or from the Relay's listener.
export const relayTunnelPath = "/api/relays/tunnel"
export const relayTunnelProtocol = "kiln-relay-tunnel.v1" as const
export const relayTunnelTokenHeader = "x-kiln-tunnel-token"
// How Hearth closes a connection a Relay opened: it already has one to that
// Relay it keeps, or it doesn't know the Relay.
export const relayDialCloseCodes = {
  duplicate: 4409,
  unknownRelay: 4404,
} as const
export const relayBrowserAuthorizationReviseMaxItems = 256

export const relayControlOperations = [
  "relay.snapshot",
  "relay.tunnel.open",
  "relay.system.inspect",
  "relay.update.apply",
  "relay.update.status",
  "relay.restart",
  "relay.resources.read",
  "relay.rename",
  "relay.audit.list",
  "relay.networking.read",
  "relay.networking.write",
  "relay.tailscale.install",
  "relay.tailscale.read",
  "relay.tailscale.write",
  "relay.tailscale.stack.apply",
  "relay.tailscale.stack.dns",
  "relay.tailscale.stack.list",
  "relay.tailscale.stack.remove",
  "relay.host.read",
  "relay.host.files.mount",
  "relay.host.restart",
  "relay.database.read",
  "relay.terminal.attach",
  "relay.terminal.heartbeat",
  "relay.terminal.detach",
  "relay.terminal.write",
  "relay.terminal.claim",
  "relay.terminal.restart",
  "relay.platform.terminal.attach",
  "relay.platform.terminal.heartbeat",
  "relay.platform.terminal.detach",
  "relay.platform.terminal.write",
  "relay.platform.terminal.claim",
  "relay.platform.terminal.restart",
  "relay.proxy.read",
  "relay.proxy.config.read",
  "relay.proxy.write",
  "relay.volumes.read",
  "relay.volumes.create",
  "relay.volumes.rename",
  "relay.volumes.delete",
  "relay.volumes.references.import",
  "relay.volumes.references.hold",
  "relay.pairing.create",
  "relay.pairing.list",
  "relay.pairing.revoke",
  "relay.clients.list",
  "relay.clients.update",
  "relay.clients.revoke",
  "relay.platform.read",
  "relay.platform.logs",
  "relay.platform.action",
  "relay.platform.database.read",
  "relay.platform.database.write",
  "relay.installation.read",
  "relay.installation.replace",
  "relay.security.targets",
  "relay.security.inventory",
  "browser.authorization.revise",
  "brick.catalog",
  "brick.recipe",
  "database.list",
  "database.inspect",
  "database.create",
  "database.provision.prepare",
  "database.provision.claim",
  "database.provision.cancel",
  "database.wipe",
  "database.delete",
  "database.action",
  "database.limits.write",
  "database.credentials.rotate",
  "database.network.write",
  "database.network.import",
  "database.dump.export",
  "database.dump.import",
  "database.data.read",
  "database.data.write",
  "database.terminal.attach",
  "database.terminal.heartbeat",
  "database.terminal.detach",
  "database.terminal.write",
  "database.terminal.claim",
  "database.terminal.restart",
  "app.list",
  "app.create",
  "app.provision.prepare",
  "app.provision.claim",
  "app.provision.cancel",
  "app.delete",
  "app.deploy",
  "app.action",
  "app.limits.write",
  "app.volumes.write",
  "app.network.routes.read",
  "app.deployment.read",
  "app.image.check",
  "app.network.routes.write",
  "app.terminal.attach",
  "app.terminal.heartbeat",
  "app.terminal.detach",
  "app.terminal.write",
  "app.terminal.claim",
  "app.terminal.restart",
  "backup.task.enqueue",
  "backup.task.cancel",
  "backup.restore.resolve",
  "backup.task.get",
  "backup.task.list",
  "transfer.source.prepare",
  "transfer.source.get",
  "transfer.source.discard",
  "transfer.pull.start",
  "transfer.pull.get",
  "transfer.pull.cancel",
  "transfer.space",
  "schedule.apply",
  "schedule.run",
  "schedule.remove",
  "schedule.overview",
  "instance.create",
  "instance.provision.prepare",
  "instance.provision.claim",
  "instance.provision.cancel",
  "instance.startup.write",
  "instance.rename",
  "instance.delete",
  "instance.action",
  "instance.resources.read",
  "instance.files.list",
  "instance.files.directory.list",
  "instance.files.directory.sizes",
  "instance.files.search",
  "instance.files.stat",
  "instance.files.read",
  "instance.icon.read",
  "instance.files.write",
  "instance.files.put",
  "instance.files.upload-url",
  "instance.files.mutate",
  "instance.files.mutate.result",
  "instance.files.database.read",
  "instance.files.database.write",
  "instance.console.history",
  "instance.console.write",
  "instance.console.complete",
  "instance.logs.share",
  "instance.logs.latest",
  "instance.network.ports.reserve",
  "instance.network.ports.release",
  "instance.network.ports.write",
  "instance.network.routes.read",
  "instance.network.routes.write",
  "instance.network.databases.remove",
  "hearth.tailscale.member.detach",
  "hearth.database.terminal.output",
  "sftp.authorization.resolve",
  "operation.get",
  "relay.pause.write",
] as const

export type RelayControlOperation = (typeof relayControlOperations)[number]

const auditedRelayControlOperations = new Set<RelayControlOperation>([
  "relay.rename",
  "relay.update.apply",
  "relay.restart",
  "relay.host.restart",
  "relay.pairing.create",
  "relay.pairing.revoke",
  "relay.clients.update",
  "relay.clients.revoke",
  "relay.networking.write",
  "relay.volumes.create",
  "relay.volumes.rename",
  "relay.volumes.delete",
  "relay.volumes.references.import",
  "relay.volumes.references.hold",
  "relay.tailscale.install",
  "relay.tailscale.stack.apply",
  "relay.tailscale.stack.dns",
  "relay.tailscale.stack.remove",
  "relay.tailscale.write",
  "relay.proxy.write",
  "relay.platform.action",
  "relay.terminal.attach",
  "relay.terminal.restart",
  "relay.platform.terminal.attach",
  "relay.platform.terminal.restart",
  "relay.platform.database.write",
  "relay.installation.replace",
  "instance.create",
  "instance.provision.prepare",
  "instance.provision.claim",
  "instance.provision.cancel",
  "instance.startup.write",
  "instance.rename",
  "instance.delete",
  "instance.action",
  "instance.files.write",
  "instance.files.put",
  "instance.files.upload-url",
  "instance.files.mutate",
  "instance.files.database.write",
  "instance.console.write",
  "instance.network.ports.write",
  "instance.network.routes.write",
  "instance.network.databases.remove",
  "database.create",
  "database.provision.prepare",
  "database.provision.claim",
  "database.provision.cancel",
  "database.delete",
  "database.wipe",
  "database.action",
  "database.limits.write",
  "database.credentials.rotate",
  "database.network.write",
  "database.network.import",
  "database.dump.export",
  "database.dump.import",
  "database.data.write",
  "database.terminal.attach",
  "database.terminal.restart",
  "app.create",
  "app.provision.prepare",
  "app.provision.claim",
  "app.provision.cancel",
  "app.delete",
  "app.deploy",
  "app.action",
  "app.limits.write",
  "app.volumes.write",
  "app.network.routes.write",
  "app.terminal.attach",
  "app.terminal.restart",
  "backup.task.enqueue",
  "backup.task.cancel",
  "backup.restore.resolve",
  "transfer.source.prepare",
  "transfer.source.discard",
  "transfer.pull.start",
  "transfer.pull.cancel",
  "schedule.apply",
  "schedule.run",
  "schedule.remove",
])

export function isAuditedRelayControlOperation(
  operation: RelayControlOperation
): boolean {
  return auditedRelayControlOperations.has(operation)
}

/**
 * Whether an operation changes something, so the Relay records it under its
 * operation ID and Hearth looks it up when its reply is lost. Reads, terminal session traffic, and
 * requests the Relay sends Hearth don't.
 */
export function relayControlOperationChanges(
  operation: RelayControlOperation
): boolean {
  switch (operation) {
    case "relay.snapshot":
    case "relay.tunnel.open":
    case "relay.system.inspect":
    case "relay.update.status":
    case "relay.resources.read":
    case "relay.audit.list":
    case "relay.networking.read":
    case "relay.tailscale.read":
    case "relay.tailscale.stack.list":
    case "relay.host.read":
    case "relay.database.read":
    case "relay.proxy.read":
    case "relay.proxy.config.read":
    case "relay.volumes.read":
    case "relay.pairing.list":
    case "relay.clients.list":
    case "relay.platform.read":
    case "relay.installation.read":
    case "relay.platform.logs":
    case "relay.platform.database.read":
    case "relay.security.targets":
    case "relay.security.inventory":
    case "brick.catalog":
    case "brick.recipe":
    case "database.list":
    case "database.inspect":
    case "database.data.read":
    case "database.dump.export":
    case "app.list":
    case "app.network.routes.read":
    case "app.deployment.read":
    case "app.image.check":
    case "backup.task.get":
    case "backup.task.list":
    case "transfer.source.get":
    case "transfer.pull.get":
    case "transfer.space":
    case "schedule.overview":
    case "instance.resources.read":
    case "instance.files.list":
    case "instance.files.directory.list":
    case "instance.files.directory.sizes":
    case "instance.files.search":
    case "instance.files.stat":
    case "instance.files.read":
    case "instance.icon.read":
    case "instance.files.database.read":
    case "instance.console.history":
    case "instance.logs.latest":
    case "instance.network.routes.read":
    case "relay.terminal.attach":
    case "relay.terminal.heartbeat":
    case "relay.terminal.detach":
    case "relay.terminal.write":
    case "relay.terminal.claim":
    case "relay.terminal.restart":
    case "relay.platform.terminal.attach":
    case "relay.platform.terminal.heartbeat":
    case "relay.platform.terminal.detach":
    case "relay.platform.terminal.write":
    case "relay.platform.terminal.claim":
    case "relay.platform.terminal.restart":
    case "database.terminal.attach":
    case "database.terminal.heartbeat":
    case "database.terminal.detach":
    case "database.terminal.write":
    case "database.terminal.claim":
    case "database.terminal.restart":
    case "app.terminal.attach":
    case "app.terminal.heartbeat":
    case "app.terminal.detach":
    case "app.terminal.write":
    case "app.terminal.claim":
    case "app.terminal.restart":
    case "hearth.tailscale.member.detach":
    case "hearth.database.terminal.output":
    case "sftp.authorization.resolve":
    case "operation.get":
      return false
    case "relay.pause.write":
    case "relay.update.apply":
    case "relay.restart":
    case "relay.rename":
    case "relay.networking.write":
    case "relay.tailscale.install":
    case "relay.tailscale.write":
    case "relay.tailscale.stack.apply":
    case "relay.tailscale.stack.dns":
    case "relay.tailscale.stack.remove":
    case "relay.host.files.mount":
    case "relay.host.restart":
    case "relay.proxy.write":
    case "relay.volumes.create":
    case "relay.volumes.rename":
    case "relay.volumes.delete":
    case "relay.volumes.references.import":
    case "relay.volumes.references.hold":
    case "relay.pairing.create":
    case "relay.pairing.revoke":
    case "relay.clients.update":
    case "relay.clients.revoke":
    case "relay.platform.action":
    case "relay.platform.database.write":
    case "relay.installation.replace":
    case "browser.authorization.revise":
    case "database.create":
    case "database.provision.prepare":
    case "database.provision.claim":
    case "database.provision.cancel":
    case "database.wipe":
    case "database.delete":
    case "database.action":
    case "database.limits.write":
    case "database.credentials.rotate":
    case "database.network.write":
    case "database.network.import":
    case "database.dump.import":
    case "database.data.write":
    case "app.create":
    case "app.provision.prepare":
    case "app.provision.claim":
    case "app.provision.cancel":
    case "app.delete":
    case "app.deploy":
    case "app.action":
    case "app.limits.write":
    case "app.volumes.write":
    case "app.network.routes.write":
    case "backup.task.enqueue":
    case "backup.task.cancel":
    case "backup.restore.resolve":
    case "transfer.source.prepare":
    case "transfer.source.discard":
    case "transfer.pull.start":
    case "transfer.pull.cancel":
    case "schedule.apply":
    case "schedule.run":
    case "schedule.remove":
    case "instance.create":
    case "instance.provision.prepare":
    case "instance.provision.claim":
    case "instance.provision.cancel":
    case "instance.startup.write":
    case "instance.rename":
    case "instance.delete":
    case "instance.action":
    case "instance.files.write":
    case "instance.files.put":
    case "instance.files.upload-url":
    case "instance.files.mutate":
    case "instance.files.mutate.result":
    case "instance.files.database.write":
    case "instance.console.write":
    case "instance.console.complete":
    case "instance.logs.share":
    case "instance.network.ports.reserve":
    case "instance.network.ports.release":
    case "instance.network.ports.write":
    case "instance.network.routes.write":
    case "instance.network.databases.remove":
      return true
  }
}

// How long a Relay keeps the record of a finished change for `operation.get`.
export const relayOperationRetentionMs = 7 * 24 * 60 * 60_000

// Terminal traffic isn't journaled, but opening a shell or sending it input
// can change anything. Heartbeats and detaching only keep or end a session.
const terminalInputOperations = new Set<RelayControlOperation>([
  "app.terminal.attach",
  "app.terminal.claim",
  "app.terminal.restart",
  "app.terminal.write",
  "database.terminal.attach",
  "database.terminal.claim",
  "database.terminal.restart",
  "database.terminal.write",
  "relay.terminal.attach",
  "relay.terminal.claim",
  "relay.terminal.restart",
  "relay.terminal.write",
])

/**
 * Whether a paused Relay refuses an operation. A Relay is paused while any
 * Hearth holds it paused (`relay.pause.write`), and then runs nothing that
 * changes anything, from Hearth or of its own accord: no change and no
 * terminal input. Pausing and resuming it, and revoking access, still reach
 * it whatever its state.
 */
export function relayControlOperationRefusedWhilePaused(
  operation: RelayControlOperation
): boolean {
  if (
    operation === "relay.pause.write" ||
    operation === "browser.authorization.revise" ||
    // Only adds protection, which restoring Hearth's database needs.
    operation === "relay.volumes.references.hold" ||
    operation === "relay.clients.revoke" ||
    operation === "relay.pairing.revoke"
  ) {
    return false
  }
  return (
    relayControlOperationChanges(operation) ||
    terminalInputOperations.has(operation)
  )
}

export function relayControlDeadlineMs(
  operation: RelayControlOperation
): number {
  if (operation === "relay.terminal.attach") return 360_000
  if (operation === "relay.update.apply") return 15 * 60_000
  // The host's shell helper may have to be pulled first.
  if (operation === "relay.host.restart") return 120_000
  if (operation === "relay.tailscale.install") return 240_000
  if (operation === "relay.tailscale.stack.apply") return 240_000
  if (operation === "relay.tailscale.stack.remove") return 120_000
  if (operation === "relay.tailscale.stack.dns") return 60_000
  // Proxy and networking writes can pull and start edge containers.
  if (operation === "relay.proxy.write") return 240_000
  if (operation === "relay.networking.write") return 240_000
  if (operation === "relay.tailscale.write") return 90_000
  if (operation === "relay.host.files.mount") return 60_000
  // A repair can wait for MySQL to become healthy.
  if (operation === "relay.platform.action") return 240_000
  // An inventory may first wait for the host to be less busy, then reads a
  // whole image through Docker at the lowest priority.
  if (operation === "relay.security.inventory") return 15 * 60_000
  if (operation === "hearth.tailscale.member.detach") return 60_000
  if (operation === "instance.delete") return 360_000
  if (operation === "database.create") return 360_000
  if (operation === "database.delete") return 180_000
  if (operation === "app.delete") return 180_000
  if (operation === "app.action") return 180_000
  if (operation === "app.create") return 60_000
  // Up to four registry lookups at a time, each up to 20 seconds; Hearth
  // sends at most 16 apps per request.
  if (operation === "app.image.check") return 120_000
  if (operation === "database.action") return 180_000
  // Removing a limit recreates the container and waits for it to be ready.
  if (operation === "database.limits.write") return 240_000
  if (operation === "database.credentials.rotate") return 180_000
  // Waits its turn behind changes to every App and database it names.
  if (operation === "database.network.import") return 120_000
  // Dumps take as long as the database's data does.
  if (operation === "database.dump.export") return 60 * 60_000
  // Docker walks every volume to measure them.
  if (operation === "database.inspect") return 75_000
  // Measuring a root walks every file in it.
  if (operation === "transfer.space") return 120_000
  if (operation === "database.wipe") return 120_000
  if (operation === "database.dump.import") return 60 * 60_000
  if (operation === "instance.action") return 180_000
  if (
    operation === "schedule.apply" ||
    operation === "schedule.run" ||
    operation === "schedule.remove"
  ) {
    return 30_000
  }
  if (operation === "instance.logs.share") return 60_000
  // The CLI saves files of up to the control frame limit.
  if (operation === "instance.files.write") return 180_000
  if (
    operation === "instance.create" ||
    operation === "instance.startup.write" ||
    operation === "instance.files.upload-url"
  ) {
    return 360_000
  }
  return operation === "instance.network.ports.write" ||
    operation === "instance.network.routes.write" ||
    operation === "app.network.routes.write"
    ? 240_000
    : 30_000
}

export const RelayControlOperationSchema = Schema.Literals(
  relayControlOperations
)

export const relaySnapshotDeltaFeature = "relay.snapshot.delta.v1"
// Hearth keeps node resource samples (CPU, memory, Relay memory) current, so
// snapshot deltas carry the node whenever those samples change. Older Hearths
// would forward every such delta to browsers, so they never receive them.
export const relaySnapshotNodeResourcesFeature =
  "relay.snapshot.node-resources.v1"

// On a connection the Relay opened, Hearth speaks first: the nonce the
// Relay's challenge must carry. Hearth trusts no challenge it didn't ask
// for, so a recorded one can't be replayed to it.
export const RelayDialHelloSchema = Schema.Struct({
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z\d_-]{43}$/u)),
  type: Schema.Literal("dial.hello"),
  v: Schema.Literal(1),
})

export type RelayDialHello = typeof RelayDialHelloSchema.Type

// What `relay.tunnel.open` asks and answers: the tunnel's token, and
// whether the listener it reaches speaks TLS.
export const RelayTunnelOpenSchema = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z\d_-]{43}$/u)),
})
export const RelayTunnelOpenedSchema = Schema.Struct({ tls: Schema.Boolean })

// What a challenge on a connection the Relay opened is bound to: the Hearth
// client it's for, so one Hearth paired with a Relay can't pass its
// challenge to another, Hearth's nonce, so it can't be replayed, and the
// Hearth origin the Relay dialed, which Hearth doesn't hold it to: a Relay
// still dialing an address Hearth moved from learns its new one.
export const RelayDialBindingSchema = Schema.Struct({
  clientId: Schema.String,
  hearthNonce: Schema.String,
  hearthOrigin: Schema.String,
})

export type RelayDialBinding = typeof RelayDialBindingSchema.Type

export const RelayAuthChallengeSchema = Schema.Struct({
  dial: Schema.optionalKey(RelayDialBindingSchema),
  expiresAt: Schema.Number,
  nonce: Schema.String,
  relayId: Schema.String,
  sessionId: Schema.String,
  signature: Schema.String,
  type: Schema.Literal("auth.challenge"),
  v: Schema.Literal(1),
})

export const RelayAuthResponseSchema = Schema.Struct({
  clientId: Schema.String,
  features: Schema.optionalKey(Schema.Array(Schema.String)),
  // Hearth's installation ID, which the Relay saves as its own. Relays
  // validate it themselves so an ID they can't use never fails authentication.
  installationId: Schema.optionalKey(Schema.String),
  // The container Hearth runs in, and an HMAC of
  // `relayHearthContainerTranscript` keyed by its BETTER_AUTH_SECRETS, which
  // a Relay on the same host checks against that container's environment.
  // It then finds Kiln's services without Kiln's labels, as under Coolify.
  hearthContainer: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, proof: Schema.String })
  ),
  // Where the Relay should open its own control connection to this Hearth,
  // or null to stop. Relays with `relayControlDialV1Feature` keep it.
  dial: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ url: Schema.String }))
  ),
  signature: Schema.String,
  type: Schema.Literal("auth.response"),
  v: Schema.Literal(1),
})

export const RelayAuthReadySchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  browserIssuerGeneration: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  clientId: Schema.String,
  features: Schema.optionalKey(Schema.Array(Schema.String)),
  // The Relay's journal of changes, which `operation.get` answers from. A
  // rebuilt Relay state starts a new one, which forgets every change.
  journalId: Schema.optionalKey(Schema.String),
  protocol: Schema.Literal(relayControlProtocol),
  relayBuild: Schema.String,
  role: Schema.Literals(["full_access", "read_only", "custom"]),
  type: Schema.Literal("auth.ready"),
  v: Schema.Literal(1),
})

export const RelayBrowserOperationKindSchema = Schema.Literals([
  "console",
  "file",
  "resources",
])

// The kinds of resource a browser capability can be for. Its `instanceId` is
// the resource's ID (a Relay's own ID for `relay` and `platform`, Kiln's
// services on its host); capabilities without `resourceKind` are for servers.
export const relayBrowserResourceKinds = [
  "instance",
  "database",
  "app",
  "relay",
  "platform",
] as const

export const RelayBrowserResourceKindSchema = Schema.Literals(
  relayBrowserResourceKinds
)

export type RelayBrowserResourceKind =
  typeof RelayBrowserResourceKindSchema.Type

export interface RelayConsoleResource {
  readonly id: string
  readonly kind: RelayBrowserResourceKind
  // Which of the resource's outputs to follow, for kinds with more than one:
  // an app's deployment log or one of its services, or one of Kiln's
  // containers.
  readonly stream?: string
}

// The action that reads each kind of resource's console output. Only servers
// take console input.
export const relayConsoleReadActions = {
  app: "app.logs.read",
  database: "database.logs.read",
  instance: "instance.console.read",
  // Hearth issues these only to platform administrators.
  platform: "relay.logs.read",
  relay: "relay.logs.read",
} as const satisfies Record<RelayBrowserResourceKind, string>

export const RelayBrowserCapabilityV1Schema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  audience: Schema.String,
  capabilityId: Schema.String,
  expiresAt: Schema.Number,
  instanceId: Schema.String,
  issuedAt: Schema.Number,
  issuer: Schema.String,
  keyThumbprint: Schema.String,
  origin: Schema.String,
  path: Schema.NullOr(Schema.String),
  subject: Schema.String,
  version: Schema.Literal(1),
})

export const RelayBrowserCapabilityV2Schema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  audience: Schema.String,
  authorizationRevision: Schema.Number,
  capabilityId: Schema.String,
  expiresAt: Schema.Number,
  instanceId: Schema.String,
  issuedAt: Schema.Number,
  issuer: Schema.String,
  issuerGeneration: Schema.Number,
  keyThumbprint: Schema.String,
  loginSessionId: Schema.String,
  operation: RelayBrowserOperationKindSchema,
  origin: Schema.String,
  path: Schema.NullOr(Schema.String),
  // Absent for servers, so Relays without other kinds read these unchanged.
  // Relays that predate a kind ignore it and refuse the kind's actions.
  resourceKind: Schema.optionalKey(RelayBrowserResourceKindSchema),
  subject: Schema.String,
  version: Schema.Literal(2),
})

export const RelayBrowserCapabilitySchema = Schema.Union([
  RelayBrowserCapabilityV1Schema,
  RelayBrowserCapabilityV2Schema,
])

export const RelayBrowserRenewSchema = Schema.Struct({
  capability: Schema.String,
  signature: Schema.String,
  type: Schema.Literal("auth.renew"),
  v: Schema.Literal(1),
})

export const RelayBrowserAuthorizationScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("subject_relay") }),
  Schema.Struct({
    instanceId: Schema.String,
    kind: Schema.Literal("instance"),
  }),
  Schema.Struct({
    kind: Schema.Literal("login_session"),
    loginSessionId: Schema.String,
  }),
])

export const RelayBrowserAuthorizationRevisionSchema = Schema.Struct({
  minimumRevision: Schema.Number,
  scope: RelayBrowserAuthorizationScopeSchema,
  subject: Schema.String,
})

export const RelayBrowserAuthorizationReviseSchema = Schema.Struct({
  items: Schema.Array(RelayBrowserAuthorizationRevisionSchema),
  minimumIssuerGeneration: Schema.optionalKey(Schema.Number),
})

export const RelayControlRequestSchema = Schema.Struct({
  // Retain the absolute deadline while v1 peers are still in the fleet. New
  // peers use timeoutMs so request enforcement does not depend on host clocks.
  deadline: Schema.Number,
  id: Schema.String,
  // The journal the sender expects (`auth.ready`). The Relay refuses a
  // request for another with `journal_changed`, so a change it forgot when
  // its state was rebuilt isn't taken as one it never saw.
  journalId: Schema.optionalKey(Schema.String),
  operation: RelayControlOperationSchema,
  // The Hearth operation a change is a step of, and which step, for the
  // Relay's traces and audit. It names the work; it grants nothing.
  parent: Schema.optionalKey(
    Schema.Struct({
      operationId: Schema.String.check(Schema.isMaxLength(128)),
      step: Schema.String.check(Schema.isMaxLength(256)),
    })
  ),
  payload: Schema.Unknown,
  // Names a change across reconnects; `id` names only this one frame. The
  // Relay records each change it runs under its operation ID and answers
  // `operation.get` with how it went, so Hearth learns the outcome of a
  // change whose reply a dropped connection lost.
  operationId: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
  // The W3C `traceparent` of the sender's span, so the receiver's work joins
  // its trace and follows its sampling. Peers that predate it drop the key,
  // and a value the receiver can't parse only starts a trace of its own.
  traceparent: Schema.optionalKey(Schema.String),
  type: Schema.Literal("request"),
  v: Schema.Literal(1),
})

/**
 * What the Relay knows of a change Hearth sent under an `operationId`:
 * `unknown` if it never received one by that ID, which means it never ran;
 * `interrupted` if the Relay restarted while it ran, so it may or may not
 * have taken effect.
 */
export const RelayOperationLookupSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({ status: Schema.Literal("running") }),
  // `result` is the reply it sent, while the Relay still has it.
  Schema.Struct({
    result: Schema.optionalKey(Schema.Unknown),
    status: Schema.Literal("succeeded"),
  }),
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    status: Schema.Literal("failed"),
  }),
  Schema.Struct({ status: Schema.Literal("interrupted") }),
])
export type RelayOperationLookup = typeof RelayOperationLookupSchema.Type

export const RelayControlCancelSchema = Schema.Struct({
  id: Schema.String,
  replyTo: Schema.String,
  type: Schema.Literal("cancel"),
  v: Schema.Literal(1),
})

export const RelayControlResponseSchema = Schema.Struct({
  id: Schema.String,
  payload: Schema.Unknown,
  replyTo: Schema.String,
  type: Schema.Literal("response"),
  v: Schema.Literal(1),
})

export const RelayControlErrorSchema = Schema.Struct({
  code: Schema.String,
  id: Schema.String,
  message: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  type: Schema.Literal("error"),
  v: Schema.Literal(1),
})

export const RelayControlEventSchema = Schema.Struct({
  event: Schema.String,
  id: Schema.String,
  payload: Schema.Unknown,
  seq: Schema.Number,
  type: Schema.Literal("event"),
  v: Schema.Literal(1),
})

export const RelayControlClientMessageSchema = Schema.Union([
  RelayAuthResponseSchema,
  RelayControlRequestSchema,
  RelayControlCancelSchema,
  RelayControlResponseSchema,
  RelayControlErrorSchema,
])

export const RelayControlServerMessageSchema = Schema.Union([
  RelayAuthChallengeSchema,
  RelayAuthReadySchema,
  RelayControlCancelSchema,
  RelayControlResponseSchema,
  RelayControlErrorSchema,
  RelayControlEventSchema,
  RelayControlRequestSchema,
])

export type RelayAuthChallenge = typeof RelayAuthChallengeSchema.Type
export type RelayAuthResponse = typeof RelayAuthResponseSchema.Type
export type RelayAuthReady = typeof RelayAuthReadySchema.Type
export type RelayBrowserCapability = typeof RelayBrowserCapabilitySchema.Type
export type RelayBrowserCapabilityV1 =
  typeof RelayBrowserCapabilityV1Schema.Type
export type RelayBrowserCapabilityV2 =
  typeof RelayBrowserCapabilityV2Schema.Type
export type RelayBrowserOperationKind =
  typeof RelayBrowserOperationKindSchema.Type
export type RelayBrowserRenew = typeof RelayBrowserRenewSchema.Type
export type RelayBrowserAuthorizationScope =
  typeof RelayBrowserAuthorizationScopeSchema.Type
export type RelayBrowserAuthorizationRevision =
  typeof RelayBrowserAuthorizationRevisionSchema.Type
export type RelayBrowserAuthorizationRevise =
  typeof RelayBrowserAuthorizationReviseSchema.Type
export type RelayControlRequest = typeof RelayControlRequestSchema.Type
export type RelayControlCancel = typeof RelayControlCancelSchema.Type
export type RelayControlResponse = typeof RelayControlResponseSchema.Type
export type RelayControlError = typeof RelayControlErrorSchema.Type
export type RelayControlEvent = typeof RelayControlEventSchema.Type
export type RelayControlClientMessage =
  typeof RelayControlClientMessageSchema.Type
export type RelayControlServerMessage =
  typeof RelayControlServerMessageSchema.Type

export function relayControlRequestTimeoutMs(
  request: RelayControlRequest,
  receivedAt: number
): number | null {
  const requested = request.timeoutMs ?? request.deadline - receivedAt
  if (!Number.isFinite(requested) || requested <= 0) return null
  return Math.min(requested, relayControlDeadlineMs(request.operation))
}

export function relayAuthChallengeTranscript(
  challenge: Omit<RelayAuthChallenge, "signature">
): string {
  return JSON.stringify([
    relayControlProtocol,
    "challenge",
    challenge.relayId,
    challenge.sessionId,
    challenge.nonce,
    challenge.expiresAt,
    ...(challenge.dial
      ? [
          "dial",
          challenge.dial.clientId,
          challenge.dial.hearthNonce,
          challenge.dial.hearthOrigin,
        ]
      : []),
  ])
}

export function relayAuthResponseTranscript(
  challenge: Omit<RelayAuthChallenge, "signature">,
  clientId: string
): string {
  return JSON.stringify([
    relayControlProtocol,
    "response",
    challenge.relayId,
    clientId,
    challenge.sessionId,
    challenge.nonce,
    challenge.expiresAt,
  ])
}

export function relayHearthContainerTranscript(
  challenge: Omit<RelayAuthChallenge, "signature">,
  clientId: string,
  containerId: string
): string {
  return JSON.stringify([
    relayControlProtocol,
    "hearth-container",
    challenge.relayId,
    clientId,
    challenge.sessionId,
    challenge.nonce,
    containerId,
  ])
}

export interface RelayPairingRequestContract {
  readonly bootstrapProof: string | null
  readonly hearthName: string
  readonly hearthOrigin: string
  readonly invitationId: string
  readonly nonce: string
  readonly publicKeyPem: string
  readonly signature: string
  readonly token: string | null
  readonly version: 1
}

export interface RelayPairingResponseContract {
  readonly actions: ReadonlyArray<string>
  readonly clientId: string
  readonly expiresAt: number
  readonly nonce: string
  readonly relayFingerprint: string
  readonly relayName: string
  readonly relayPublicKeyPem: string
  readonly role: "custom" | "full_access" | "read_only"
  readonly signature: string
  readonly version: 1
}

export function relayPairingRequestTranscript(
  request: RelayPairingRequestContract
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "request",
    request.invitationId,
    request.token
      ? ["token", request.token]
      : ["bootstrap", request.bootstrapProof],
    request.hearthName,
    new URL(request.hearthOrigin).origin,
    request.nonce,
    request.publicKeyPem,
  ])
}

export function relayBootstrapDiscoveryTranscript(input: {
  readonly clientNonce: string
  readonly controlEndpoint: string
  readonly expiresAt: number
  readonly invitationId: string
  readonly relayFingerprint: string
  readonly relayPublicKeyPem: string
  readonly serverNonce: string
  readonly tlsFingerprint: string
}): string {
  return JSON.stringify([
    relayPairingProtocol,
    "bootstrap-discovery",
    input.clientNonce,
    input.serverNonce,
    input.tlsFingerprint,
    input.relayFingerprint,
    input.relayPublicKeyPem,
    input.controlEndpoint,
    input.invitationId,
    input.expiresAt,
  ])
}

export function relayBootstrapEnrollmentTranscript(
  request: Pick<
    RelayPairingRequestContract,
    | "hearthName"
    | "hearthOrigin"
    | "invitationId"
    | "nonce"
    | "publicKeyPem"
    | "version"
  >
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "bootstrap-enrollment",
    request.invitationId,
    request.hearthName,
    new URL(request.hearthOrigin).origin,
    request.nonce,
    request.publicKeyPem,
  ])
}

export function relayPairingResponseTranscript(
  response: Omit<RelayPairingResponseContract, "signature">
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "response",
    response.clientId,
    response.relayFingerprint,
    response.relayName,
    response.relayPublicKeyPem,
    response.role,
    response.actions,
    response.nonce,
    response.expiresAt,
  ])
}

export function relayBrowserProofTranscript(
  input: {
    readonly capabilityId: string
    readonly expiresAt: number
    readonly nonce: string
    readonly relayId: string
    readonly sessionId: string
  },
  protocol:
    | typeof relayBrowserProtocol
    | typeof relayBrowserConsoleProtocol = relayBrowserProtocol
): string {
  return JSON.stringify([
    protocol,
    "proof",
    input.relayId,
    input.sessionId,
    input.nonce,
    input.expiresAt,
    input.capabilityId,
  ])
}

export function relayBrowserRequestProofTranscript(input: {
  readonly capabilityId: string
  readonly expiresAt: number
  readonly instanceId: string
  readonly method: "GET" | "HEAD" | "POST" | "PUT"
  readonly nonce: string
  readonly path: string
  readonly relayId: string
  readonly requestedAt: number
}): string {
  return JSON.stringify([
    relayBrowserProtocol,
    "request-proof",
    input.relayId,
    input.capabilityId,
    input.expiresAt,
    input.method,
    input.instanceId,
    input.path,
    input.nonce,
    input.requestedAt,
  ])
}
