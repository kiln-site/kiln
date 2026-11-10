/**
 * The one-time moves of what one kind of instance had under its own name
 * onto the permissions and Relay actions every instance takes. Each stored
 * permission or action becomes the ones that allow the same things, so
 * nobody loses anything they could do. Hearth and every Relay rewrite what
 * they stored with these, whichever migrates first.
 *
 * Files: an App's files had `app.files.read` and `app.files.write`, and
 * Relay actions of their own beside a game server's.
 *
 * Power: a database's took `database.power`, and an App's went with
 * configuring it (`app.manage`). Both covered every power action.
 *
 * Deploying: an App's went with configuring it (`app.manage`), and a game
 * server's reinstall with changing its configuration. A database had none.
 */
const fileActions: Readonly<Record<string, ReadonlyArray<string>>> = {
  "app.files.read": ["instance.files.list", "instance.files.read"],
  // Changing an App's files covered every change to them.
  "app.files.write": [
    "instance.files.write",
    "instance.files.delete",
    "instance.files.rename",
    "instance.files.upload-url",
  ],
  "app.files.download": ["instance.files.download"],
  "app.files.upload": ["instance.files.upload"],
}

const filePermissions: Readonly<Record<string, ReadonlyArray<string>>> = {
  "app.files.read": ["instance.files.read"],
  // Only a game server's files told deleting from writing.
  "app.files.write": ["instance.files.write", "instance.files.delete"],
}

function replaced(
  keys: ReadonlyArray<string>,
  replacements: Readonly<Record<string, ReadonlyArray<string>>>
): Array<string> {
  return [...new Set(keys.flatMap((key) => replacements[key] ?? [key]))]
}

/** A Relay client's actions, with an App's file actions replaced. */
export function migratedFileActions(
  actions: ReadonlyArray<string>
): Array<string> {
  return replaced(actions, fileActions)
}

/**
 * The permissions that replace one a grant or preset on a Relay selected,
 * or null for one this move leaves alone.
 */
export function migratedFilePermissions(
  permission: string
): ReadonlyArray<string> | null {
  return filePermissions[permission] ?? null
}

// The Relay names each power action, where a permission includes the gentler
// ones.
const everyPowerAction = [
  "instance.power.start",
  "instance.power.stop",
  "instance.power.restart",
  "instance.power.kill",
] as const

const powerActions: Readonly<Record<string, ReadonlyArray<string>>> = {
  "database.power": everyPowerAction,
  // Still what configuring and deploying an App takes.
  "app.manage": ["app.manage", ...everyPowerAction],
}

/** A Relay client's actions, with a database's and an App's power replaced. */
export function migratedPowerActions(
  actions: ReadonlyArray<string>
): Array<string> {
  return replaced(actions, powerActions)
}

/**
 * The permission that carries every power action: what replaces
 * `database.power`, and goes beside `app.manage`.
 */
export const migratedPowerPermission = "instance.power.kill"

// On a Relay, reinstalling a game server went with creating one, as changing
// a database's limits goes with creating a database.
const deployActions: Readonly<Record<string, ReadonlyArray<string>>> = {
  // Still what configuring an App takes.
  "app.manage": ["app.manage", "instance.deploy"],
  "instance.create": ["instance.create", "instance.deploy"],
  "database.create": ["database.create", "instance.deploy"],
}

/**
 * A Relay client's actions, with deploying added beside the actions that
 * covered it, or that replace a database's container as a deploy does.
 */
export function migratedDeployActions(
  actions: ReadonlyArray<string>
): Array<string> {
  return replaced(actions, deployActions)
}

/** The permission that deploys an instance of any kind again. */
export const migratedDeployPermission = "instance.deploy"
