/**
 * Which lane locks each kind of Relay work takes. Every actor that changes a
 * resource uses these, so Hearth requests, browser and SFTP writes,
 * schedules, crash recovery, and background workers wait for each other.
 */
import {
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  isRelayFileRoot,
  type BackupTaskInput,
  type RelayControlOperation,
} from "@workspace/contracts"

import {
  exclusive,
  laneKeys,
  shared,
  type LaneLock,
} from "./operation-lanes.js"

/** Changing a game server's running process: power and console input. */
export function instanceLifecycleLocks(instanceId: string): Array<LaneLock> {
  return [
    shared(laneKeys.instance(instanceId)),
    exclusive(laneKeys.instanceLifecycle(instanceId)),
  ]
}

/**
 * Starting a game server also recreates its container with its current
 * routes and ports, so it waits for route and proxy changes.
 */
export function instanceStartLocks(instanceId: string): Array<LaneLock> {
  return [...instanceLifecycleLocks(instanceId), shared(laneKeys.routes)]
}

export function instancePowerLocks(
  instanceId: string,
  action: string
): Array<LaneLock> {
  return action === "start" || action === "restart"
    ? instanceStartLocks(instanceId)
    : instanceLifecycleLocks(instanceId)
}

/** Writing a game server's files. Live backups run alongside. */
export function instanceFileLocks(instanceId: string): Array<LaneLock> {
  return [
    shared(laneKeys.instance(instanceId)),
    exclusive(laneKeys.instanceFiles(instanceId)),
  ]
}

/** Reading a game server whole, as a backup does, while it keeps running. */
export function instanceReadLocks(instanceId: string): Array<LaneLock> {
  return [shared(laneKeys.instance(instanceId))]
}

/** Replacing a game server: delete, reinstall, restore, or recreation. */
export function instanceReplaceLocks(instanceId: string): Array<LaneLock> {
  return [exclusive(laneKeys.instance(instanceId))]
}

export function appLifecycleLocks(appId: string): Array<LaneLock> {
  return [shared(laneKeys.app(appId)), exclusive(laneKeys.appLifecycle(appId))]
}

export function appFileLocks(appId: string): Array<LaneLock> {
  return [shared(laneKeys.app(appId)), exclusive(laneKeys.appFiles(appId))]
}

export function appReplaceLocks(appId: string): Array<LaneLock> {
  return [exclusive(laneKeys.app(appId))]
}

export function databaseLocks(databaseId: string): Array<LaneLock> {
  return [exclusive(laneKeys.database(databaseId))]
}

/** Reading a database whole, as a dump or backup does. */
export function databaseReadLocks(databaseId: string): Array<LaneLock> {
  return [shared(laneKeys.database(databaseId))]
}

/** Writes under a file root, which is a game server, an App, or the host. */
export function fileRootWriteLocks(
  rootId: string,
  resolveInstance: InstanceResolver
): ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>> {
  if (isRelayFileRoot(rootId)) return [exclusive(laneKeys.hostFiles)]
  const appId = appIdFromFileRoot(rootId)
  if (appId) return appFileLocks(appId)
  return withInstance(resolveInstance(rootId), instanceFileLocks)
}

/**
 * A backup reads its target as it runs and a restore replaces it. Exports,
 * prunes, and deletes touch only stored artifacts.
 */
export function backupTaskLocks(
  input: BackupTaskInput,
  resolveInstance: InstanceResolver
): ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>> {
  if (input.kind !== "create" && input.kind !== "restore") return []
  const { id, kind } = input.target
  const restore = input.kind === "restore"
  if (kind === "instance") {
    return withInstance(
      resolveInstance(id),
      restore ? instanceReplaceLocks : instanceReadLocks
    )
  }
  if (kind === "database") {
    return restore ? databaseLocks(id) : databaseReadLocks(id)
  }
  return []
}

/**
 * Streaming a file into a root, as a browser upload or SFTP write does. It
 * runs alongside other file work and waits only for work that replaces the
 * whole root, such as a restore or delete. `rootId` is the full ID.
 */
export function fileRootTransferLocks(rootId: string): Array<LaneLock> {
  if (isRelayFileRoot(rootId)) return [shared(laneKeys.hostFiles)]
  // A database's dumps transfer beside reads of it, such as backups, and an
  // import, which reads the uploaded dump, waits for them.
  const databaseId = databaseIdFromFileRoot(rootId)
  if (databaseId) return databaseReadLocks(databaseId)
  const appId = appIdFromFileRoot(rootId)
  return [shared(appId ? laneKeys.app(appId) : laneKeys.instance(rootId))]
}

/**
 * Packing a root for another Relay reads it whole beside other work, as a
 * backup does, and waits only for work that replaces it. `rootId` is the
 * full ID.
 */
export function transferPackLocks(rootId: string): Array<LaneLock> {
  return fileRootTransferLocks(rootId)
}

/**
 * Installing a transfer writes a whole tree into a root, so it runs alone:
 * no SFTP session or upload can change the folder under it.
 */
export function transferInstallLocks(rootId: string): Array<LaneLock> {
  if (isRelayFileRoot(rootId)) return [exclusive(laneKeys.hostFiles)]
  const appId = appIdFromFileRoot(rootId)
  if (appId) return appReplaceLocks(appId)
  return instanceReplaceLocks(rootId)
}

/**
 * Resolves a game server reference to its full ID. Requests normally carry
 * the full ID, which needs no lookup; a short ID or name is looked up.
 */
export type InstanceResolver = (reference: string) => string | Promise<string>

/**
 * The locks a control request takes for its whole run, or null for requests
 * that change nothing a lane guards. Requests that hand work to a background
 * worker, such as backups and provisioning, take none here: the worker locks
 * the work itself when it runs it.
 */
export function controlRequestLocks(
  operation: RelayControlOperation,
  payload: Readonly<Record<string, unknown>>,
  resolveInstance: InstanceResolver
): ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>> | null {
  const instance = (
    locks: (id: string) => Array<LaneLock>,
    field = "instanceId"
  ) => {
    const reference = stringField(payload, field)
    return reference === null
      ? null
      : withInstance(resolveInstance(reference), locks)
  }
  const app = (locks: (id: string) => Array<LaneLock>, field = "appId") => {
    const id = stringField(payload, field)
    return id === null ? null : locks(id)
  }
  const database = (
    locks: (id: string) => Array<LaneLock>,
    field = "databaseId"
  ) => {
    const id = stringField(payload, field)
    return id === null ? null : locks(id)
  }
  const fileRoot = () => {
    const rootId = stringField(payload, "instanceId")
    return rootId === null ? null : fileRootWriteLocks(rootId, resolveInstance)
  }

  switch (operation) {
    // Reads, session bookkeeping, and Relay-wide settings that no lane guards.
    case "relay.snapshot":
    case "relay.system.inspect":
    case "relay.update.status":
    case "relay.resources.read":
    case "relay.volumes.read":
    case "relay.rename":
    case "relay.audit.list":
    case "relay.networking.read":
    case "relay.tailscale.read":
    case "relay.tailscale.stack.list":
    case "relay.host.read":
    case "relay.database.read":
    case "relay.proxy.read":
    case "relay.proxy.config.read":
    case "relay.pairing.create":
    case "relay.pairing.list":
    case "relay.pairing.revoke":
    case "relay.clients.list":
    case "relay.clients.update":
    case "relay.clients.revoke":
    case "relay.platform.read":
    // Inventories read images and the host's package databases, and run
    // one at a time in their own helper.
    case "relay.security.targets":
    case "relay.security.inventory":
    case "relay.platform.logs":
    case "relay.platform.database.read":
    case "relay.installation.read":
    case "browser.authorization.revise":
    case "brick.catalog":
    case "brick.recipe":
    case "database.list":
    case "database.inspect":
    case "database.data.read":
    case "app.list":
    case "app.network.routes.read":
    case "app.deployment.read":
    case "app.image.check":
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
    case "instance.logs.share":
    case "instance.logs.latest":
    case "instance.network.routes.read":
    // Port leases are their own reservation, with their own lock.
    case "instance.network.ports.reserve":
    case "instance.network.ports.release":
      return null

    // Terminals are interactive sessions, coordinated by their own registry.
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
      return null

    // Restarting or repairing Kiln's services, one change at a time, as the
    // Relay's own passes over them run.
    case "relay.platform.action":
      return [exclusive(laneKeys.platform)]
    // Writing Hearth's database waits out a restart or repair of it.
    case "relay.platform.database.write":
      return [shared(laneKeys.platform)]
    // Kiln's services and backups are found by the installation ID.
    case "relay.installation.replace":
      return [exclusive(laneKeys.platform)]

    // Updates and restarts replace the Relay itself and reserve themselves.
    case "relay.update.apply":
    case "relay.restart":
    case "relay.host.restart":
    case "relay.host.files.mount":
      return null

    // Background work locks itself when the worker runs it.
    case "backup.task.enqueue":
    case "backup.task.cancel":
    case "backup.task.get":
    case "backup.task.list":
    // A transfer packs its source and installs its pull in lanes of its own.
    case "transfer.source.prepare":
    case "transfer.source.get":
    case "transfer.source.discard":
    case "transfer.pull.start":
    case "transfer.pull.get":
    case "transfer.pull.cancel":
    // Measuring a root reads it beside whatever else runs.
    case "transfer.space":
    case "schedule.apply":
    case "schedule.run":
    case "schedule.remove":
    case "schedule.overview":
    // Provisioning only records and claims jobs; the worker takes each new
    // instance's locks for the create itself.
    case "instance.provision.prepare":
    case "instance.provision.claim":
    case "instance.provision.cancel":
    case "database.provision.prepare":
    case "database.provision.claim":
    case "database.provision.cancel":
    case "app.provision.prepare":
    case "app.provision.claim":
    case "app.provision.cancel":
      return null

    // A new game server gets an ID only the create itself knows.
    case "instance.create":
      return null

    // Looks up how an earlier change went.
    case "operation.get":
      return null

    // Holding the Relay paused changes no resource; the lanes refuse work
    // while it holds.
    case "relay.pause.write":
      return null

    // Requests the Relay sends Hearth, never the other way.
    case "hearth.tailscale.instance.detach":
    case "hearth.database.terminal.output":
    case "sftp.authorization.resolve":
      return null

    case "relay.networking.write":
    case "relay.proxy.write":
      return [exclusive(laneKeys.routes)]
    case "relay.volumes.create":
    case "relay.volumes.rename":
    case "relay.volumes.delete": {
      const id = stringField(payload, "id")
      return id ? [exclusive(laneKeys.volume(id))] : null
    }
    case "relay.tailscale.install":
    case "relay.tailscale.write":
      return [exclusive(laneKeys.tailscale)]
    case "relay.tailscale.stack.apply":
    case "relay.tailscale.stack.dns":
    case "relay.tailscale.stack.remove": {
      const locks = instance(
        (id) => [...instanceReplaceLocks(id), shared(laneKeys.tailscale)],
        "id"
      )
      return locks
    }

    case "database.create":
      return database(databaseLocks, "id")
    // Checking a limit against every instance's and applying it happen
    // together, holding the node's allocations.
    case "database.limits.write":
      return database((id) => [
        ...databaseLocks(id),
        exclusive(laneKeys.allocations),
      ])
    case "database.wipe":
    case "database.delete":
    case "database.action":
    case "database.credentials.rotate":
    case "database.dump.import":
    case "database.data.write":
      return database(databaseLocks)
    case "database.dump.export":
      return database(databaseReadLocks)
    case "database.network.write": {
      const databaseId = stringField(payload, "databaseId")
      const instanceReference = stringField(payload, "instanceId")
      if (databaseId === null || instanceReference === null) return null
      return withInstance(resolveInstance(instanceReference), (id) => [
        ...databaseLocks(databaseId),
        ...instanceLifecycleLocks(id),
      ])
    }

    case "app.create":
      return app(appReplaceLocks, "id")
    // Clears its routes once the App is gone, in a nested step.
    case "app.delete":
      return app(appReplaceLocks)
    // A deploy only checks and records the deployment; its worker takes the
    // App's lifecycle lock for the build itself. App changes that reserve
    // capacity take the node's allocations in a nested step, inside the
    // lifecycle lock, so a deployment's container start can too.
    case "app.limits.write":
    case "app.deploy":
    case "app.action":
    case "app.network.write":
      return app(appLifecycleLocks)
    case "app.network.routes.write":
      return app((id) => [...appLifecycleLocks(id), exclusive(laneKeys.routes)])

    // These replace the server's container or files, so they wait for
    // everything else on it, live backups included.
    case "instance.startup.write":
    case "instance.delete":
      return instance(instanceReplaceLocks)
    // These recreate the container with new labels, as a start does.
    case "instance.network.databases.remove":
      return instance(instanceLifecycleLocks)
    case "instance.rename":
      return instance((id) => [
        shared(laneKeys.instance(id)),
        exclusive(laneKeys.instanceMetadata(id)),
      ])
    case "instance.action": {
      const action = stringField(payload, "action") ?? ""
      return instance((id) => instancePowerLocks(id, action))
    }
    case "instance.console.write":
    case "instance.console.complete":
      return instance(instanceLifecycleLocks)
    case "instance.network.ports.write":
    case "instance.network.routes.write":
      return instance((id) => [
        ...instanceLifecycleLocks(id),
        exclusive(laneKeys.routes),
      ])
    case "instance.files.write":
    case "instance.files.put":
    case "instance.files.upload-url":
    case "instance.files.mutate":
    case "instance.files.mutate.result":
    case "instance.files.database.write":
      return fileRoot()
  }
}

function withInstance(
  resolved: string | Promise<string>,
  locks: (id: string) => ReadonlyArray<LaneLock>
): ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>> {
  return typeof resolved === "string"
    ? locks(resolved)
    : resolved.then((id) => locks(id))
}

function stringField(
  payload: Readonly<Record<string, unknown>>,
  field: string
): string | null {
  const value = payload[field]
  return typeof value === "string" && value.length > 0 ? value : null
}
