import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import mysql from "mysql2/promise"

import { parseSecretKeyring } from "../keyring.mjs"

import {
  databaseConnectionConfig,
  databaseTableName,
  prefixAuthMigrationSql,
} from "./database-config.mjs"

process.env.NODE_ENV = "production"
process.env.KILN_URL ||= "http://localhost:3000"
parseSecretKeyring(process.env.BETTER_AUTH_SECRETS)

await migrateDatabase()

const server = spawn(
  process.execPath,
  ["--import", resolve("instrument.server.mjs"), resolve("scripts/serve.mjs")],
  {
    env: process.env,
    stdio: "inherit",
  }
)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal))
}

server.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

async function migrateDatabase() {
  const database = databaseConnectionConfig()
  let connection
  let lastError
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      connection = await mysql.createConnection({
        ...database,
        multipleStatements: true,
        timezone: "Z",
      })
      break
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    }
  }
  if (!connection) throw lastError ?? new Error("Could not connect to MySQL")

  try {
    await connection.query("SET SESSION time_zone = '+00:00'")
    const [tables] = await connection.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [databaseTableName("user")]
    )
    if (tables.length === 0) {
      const authSql = await readFile(
        new URL("../migrations/auth.sql", import.meta.url),
        "utf8"
      )
      await connection.query(prefixAuthMigrationSql(authSql))
      console.info("Kiln authentication tables created")
    }
  } finally {
    await connection.end()
  }

  await import("./migrate-app.mjs")
}
