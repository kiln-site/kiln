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
  const pool = createPool({
    ...database,
    connectTimeout: 2_000,
    connectionLimit: 10,
    timezone: "Z",
  })
  pool.on("connection", (connection) => {
    // mysql2's timezone option controls JS conversion only. Queue the session
    // setting before the pool hands out this connection so SQL timestamps,
    // DATETIME defaults and expiration comparisons use the same UTC clock.
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) {
        connection.destroy()
        console.error("Could not initialize MySQL UTC session", error)
      }
    })
  })
  return pool.promise()
}

if (process.env.NODE_ENV !== "production") {
  globalDatabase.kilnDatabasePool = databasePool
}
