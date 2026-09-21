// Frozen pre-permission-model authority. Never expand this snapshot with future permissions.
const roles = {
  owner: [
    "relay.read",
    "relay.configure",
    "relay.delete",
    "access.invite",
    "access.manage",
    "instance.read",
    "instance.console.read",
    "instance.console.write",
    "instance.files.read",
    "instance.files.write",
    "instance.delete",
    "instance.power",
    "instance.settings",
    "instance.logs.share",
    "instance.network.read",
    "instance.network.write",
    "instance.network.public-port.write",
    "instance.sftp.connect",
    "database.read",
    "database.create",
    "database.credentials.read",
    "database.credentials.rotate",
    "database.power",
    "database.delete",
    "database.network.read",
    "database.network.write",
    "database.dump.export",
    "database.dump.import",
    "backup.read",
    "backup.create",
    "backup.download",
    "backup.restore",
    "backup.delete",
    "schedule.read",
    "schedule.create",
    "schedule.execute",
    "schedule.update",
    "schedule.delete",
  ],
  admin: [
    "relay.read",
    "relay.configure",
    "access.invite",
    "access.manage",
    "instance.read",
    "instance.console.read",
    "instance.console.write",
    "instance.files.read",
    "instance.files.write",
    "instance.delete",
    "instance.power",
    "instance.settings",
    "instance.logs.share",
    "instance.network.read",
    "instance.network.write",
    "instance.network.public-port.write",
    "instance.sftp.connect",
    "database.read",
    "database.create",
    "database.credentials.read",
    "database.credentials.rotate",
    "database.power",
    "database.delete",
    "database.network.read",
    "database.network.write",
    "database.dump.export",
    "database.dump.import",
    "backup.read",
    "backup.create",
    "backup.download",
    "backup.restore",
    "backup.delete",
    "schedule.read",
    "schedule.create",
    "schedule.execute",
    "schedule.update",
    "schedule.delete",
  ],
  operator: [
    "relay.read",
    "instance.read",
    "instance.console.read",
    "instance.console.write",
    "instance.files.read",
    "instance.files.write",
    "instance.power",
    "instance.logs.share",
    "instance.network.read",
    "instance.network.write",
    "instance.sftp.connect",
    "database.read",
    "database.credentials.read",
    "database.power",
    "database.network.read",
    "database.network.write",
    "database.dump.export",
    "database.dump.import",
    "backup.read",
    "backup.create",
    "backup.download",
    "backup.restore",
    "backup.delete",
    "schedule.read",
    "schedule.create",
    "schedule.execute",
    "schedule.update",
    "schedule.delete",
  ],
  viewer: [
    "relay.read",
    "instance.read",
    "instance.console.read",
    "instance.files.read",
    "instance.logs.share",
    "instance.network.read",
    "instance.sftp.connect",
    "database.read",
    "database.network.read",
    "backup.read",
    "backup.download",
    "schedule.read",
  ],
}

export function legacyAccessPermissions(role, scope, engine) {
  if (!roles[role]) throw new Error(`Unknown legacy access role: ${role}`)
  const result = new Set(roles[role])
  const splits = {
    "instance.power": [
      "instance.power.start",
      "instance.power.stop",
      "instance.power.restart",
      "instance.power.kill",
    ],
    "instance.files.write": ["instance.files.delete", "instance.files.chmod"],
    "instance.settings": [
      "instance.configuration.read",
      "instance.configuration.write",
      "instance.limits.write",
    ],
    "instance.logs.share": ["instance.logs.read"],
    "access.invite": ["access.read", "preset.read", "preset.create"],
    "access.manage": ["preset.manage"],
  }
  for (const [key, values] of Object.entries(splits)) {
    if (result.has(key)) for (const value of values) result.add(value)
  }
  return [...result].filter(
    (key) =>
      scope === "relay" ||
      (!key.startsWith("relay.") &&
        key !== "database.create" &&
        key !== "instance.create" &&
        !(scope === "database" && key.startsWith("instance.")) &&
        !(
          scope === "database" &&
          ["redis", "valkey"].includes(engine) &&
          key.startsWith("database.dump.")
        ) &&
        !(scope === "instance" && key.startsWith("database.")))
  )
}
