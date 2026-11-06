import { z } from "zod"

type DatabaseEngine = "mariadb" | "mysql" | "postgres" | "redis" | "valkey"

// What a database is called inside its engine, and the login that reaches it.
// Both go into SQL and environment variables, and the username into Redis's
// users file, so they stay plain identifiers.
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/u
const DATABASE_USERNAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u

export const databaseNameFieldSchema = z.string().regex(DATABASE_NAME_PATTERN)
export const databaseUsernameSchema = z
  .string()
  .regex(DATABASE_USERNAME_PATTERN)

/** What a new database may be given rather than have generated. */
export const newDatabaseNamesShape = {
  databaseName: databaseNameFieldSchema.optional(),
  username: databaseUsernameSchema.optional(),
}

/** Redis and Valkey have no named databases to connect to. */
export function databaseEngineHasNamedDatabase(
  engine: DatabaseEngine
): engine is "mariadb" | "mysql" | "postgres" {
  return engine !== "redis" && engine !== "valkey"
}

// Names the engine keeps for itself, or that Kiln's own work depends on: a
// wipe drops and recreates the database from `postgres`.
const reservedDatabaseNames: Record<DatabaseEngine, ReadonlySet<string>> = {
  mariadb: new Set([
    "information_schema",
    "mysql",
    "performance_schema",
    "sys",
  ]),
  mysql: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  postgres: new Set(["postgres", "template0", "template1"]),
  redis: new Set(),
  valkey: new Set(),
}

const reservedUsernames: Record<DatabaseEngine, ReadonlySet<string>> = {
  // MariaDB's image makes its own local `healthcheck` accounts, which would
  // win over this login on the local connections Kiln uses.
  mariadb: new Set(["healthcheck", "public", "root"]),
  mysql: new Set(["root"]),
  postgres: new Set([
    "current_role",
    "current_user",
    "none",
    "public",
    "root",
    "session_user",
  ]),
  // The users file turns `default` off, and can't name it twice.
  redis: new Set(["default", "root"]),
  valkey: new Set(["default", "root"]),
}

/** Why this can't name the database on this engine, if it can't. */
export function databaseNameIssue(
  engine: DatabaseEngine,
  name: string
): string | null {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    return "Start with a lowercase letter, then use lowercase letters, numbers, or underscores, up to 48 characters."
  }
  return reservedDatabaseNames[engine].has(name)
    ? `"${name}" is reserved by the database engine.`
    : null
}

/** Why this can't be the database's username on this engine, if it can't. */
export function databaseUsernameIssue(
  engine: DatabaseEngine,
  username: string
): string | null {
  if (!DATABASE_USERNAME_PATTERN.test(username)) {
    return "Start with a lowercase letter, then use lowercase letters, numbers, or underscores, up to 32 characters."
  }
  return reservedUsernames[engine].has(username) ||
    (engine === "postgres" && username.startsWith("pg_"))
    ? `"${username}" is reserved by the database engine.`
    : null
}
