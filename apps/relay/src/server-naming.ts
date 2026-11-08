/**
 * Game servers' `instance` in stored data, renamed `server`: kinds beside
 * `app` and `database`, lock keys and Tailscale members (`instance:<id>`),
 * schedule target keys (`<relay>:instance:<id>`), Docker image owners, and
 * permissions and operations (`instance.files.write`). SQLite's migration
 * `39_server_naming` and the state files' move
 * (server-naming-migration.ts) both rename with these, once.
 */
import { Result } from "effect"

// Keys whose value `instance` is a game server's kind.
const KIND_KEYS = new Set([
  "kind",
  "memberKind",
  "ownerKind",
  "resourceKind",
  "scopeKind",
  "targetKind",
  "type",
])

// Keys whose values are permissions or operations, alone or in a list.
const PERMISSION_KEYS = new Set([
  "action",
  "actions",
  "operation",
  "permission",
  "permissions",
])

// Keys whose values are lock keys, Tailscale members or owners, alone or in a
// list. Any other text, such as a console command, is kept.
const KEYED_KEYS = new Set([
  "key",
  "keys",
  "lane",
  "lanes",
  "lock",
  "locks",
  "member",
  "memberId",
  "members",
  "owner",
  "targetKey",
  "targetKeys",
])

const PERMISSION = /^instance(\.[a-z][a-z0-9_-]*)+$/u
// A lock key or member ID, or a schedule target key after its Relay's ID.
const KEYED = /^((?:[0-9a-f]+:)?)instance:/u

/** A key or text that names a game server by `instance:`, renamed. */
function renameKeyed(text: string): string {
  return text.replace(KEYED, "$1server:")
}

/** A permission or operation, `instance.*`, renamed. */
export function renameServerPermission(text: string): string {
  return PERMISSION.test(text) ? `server${text.slice("instance".length)}` : text
}

/**
 * A stored value with every game server's `instance` renamed `server`,
 * through every array and object; `key` is the key it's stored under.
 * Anything else, paths and names included, is kept.
 */
function renameServerKinds(value: unknown, key: string | null = null): unknown {
  if (typeof value === "string") {
    if (value === "instance")
      return key && KIND_KEYS.has(key) ? "server" : value
    if (key && PERMISSION_KEYS.has(key)) return renameServerPermission(value)
    return key && KEYED_KEYS.has(key) ? renameKeyed(value) : value
  }
  if (Array.isArray(value))
    return value.map((entry) => renameServerKinds(entry, key))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        renameKeyed(name),
        renameServerKinds(entry, name),
      ])
    )
  }
  return value
}

/**
 * Stored text with every game server's `instance` renamed: JSON through
 * `renameServerKinds`, kept as it was formatted, and the same text when
 * nothing changes; anything else is kept.
 */
export function renameServerKindsInText(
  text: string,
  key: string | null = null
): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text
  const parsed = Result.try(() => JSON.parse(text) as unknown)
  if (Result.isFailure(parsed)) return text
  const renamed = renameServerKinds(parsed.success, key)
  if (JSON.stringify(renamed) === JSON.stringify(parsed.success)) return text
  const indented = /^[{[]\n {2}/u.test(trimmed)
  return `${JSON.stringify(renamed, null, indented ? 2 : undefined)}${
    text.endsWith("\n") ? "\n" : ""
  }`
}
