import type { DatabaseEngine } from "@workspace/contracts"

import { databaseEngineDetails } from "@/server/managed-database-access"

/**
 * The variables that connect an App to a database, as KEY=VALUE lines for
 * its environment. Redis and Valkey have no named databases.
 */
export function appDatabaseEnvironment(credential: {
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
  password: string
  username: string
}): string {
  const { databaseId, databaseName, engine, password, username } = credential
  return [
    `DB_HOST=database-${databaseId}`,
    `DB_PORT=${databaseEngineDetails[engine].internalPort}`,
    `DB_USER=${username}`,
    `DB_PASS=${password}`,
    ...(engine === "redis" || engine === "valkey"
      ? []
      : [`DB_NAME=${databaseName}`]),
    "",
  ].join("\n")
}
