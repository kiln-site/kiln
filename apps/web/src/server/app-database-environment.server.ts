import type { DatabaseEngine } from "@workspace/contracts"


/**
 * The variables that connect an App to a database, as KEY=VALUE lines for
 * its environment. Redis and Valkey have no named databases.
 */
export function appDatabaseEnvironment(credential: {
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
  internalPort: number
  password: string
  username: string
}): string {
  const { databaseId, databaseName, engine, internalPort, password, username } =
    credential
  return [
    `DB_HOST=database-${databaseId}`,
    `DB_PORT=${internalPort}`,
    `DB_USER=${username}`,
    `DB_PASS=${password}`,
    ...(engine === "redis" || engine === "valkey"
      ? []
      : [`DB_NAME=${databaseName}`]),
    "",
  ].join("\n")
}
