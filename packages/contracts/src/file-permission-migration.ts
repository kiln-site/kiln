/**
 * The one-time move of an App's files onto the file permissions and Relay
 * actions every instance's files take.
 *
 * Before it, an App's files had permissions of their own (`app.files.read`,
 * `app.files.write`) and Relay actions of their own beside a game server's.
 * Each becomes the game server ones that allow the same things, so nobody
 * loses anything they could do to an App's files. Hearth and every Relay
 * rewrite what they stored with these, whichever migrates first.
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
