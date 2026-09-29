import { createPool } from "mysql2"
import type { Pool } from "mysql2/promise"

import { databaseConnectionConfig } from "@/lib/database-config"

const database = databaseConnectionConfig()

const globalDatabase = globalThis as typeof globalThis & {
  kilnDatabasePool?: Pool
}

export const databasePool =
  globalDatabase.kilnDatabasePool ?? createDatabasePool()

function createDatabasePool(): Pool {
  // Kiln stores times as UTC epoch milliseconds. better-auth's DATETIME
  // columns hold UTC too; mysql2 reads and writes their JS Dates as UTC.
  return createPool({
    ...database,
    connectTimeout: 2_000,
    connectionLimit: 10,
    timezone: "Z",
  }).promise()
}

if (process.env.NODE_ENV !== "production") {
  globalDatabase.kilnDatabasePool = databasePool
}
