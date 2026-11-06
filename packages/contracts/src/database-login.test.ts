import { describe, expect, it } from "vite-plus/test"

import {
  databaseNameFieldSchema,
  databaseNameIssue,
  databaseUsernameIssue,
  databaseUsernameSchema,
} from "./database-login.js"

describe("database logins", () => {
  // These reach SQL statements and Redis's users file as they are.
  it.each([
    `app'; DROP DATABASE x; --`,
    `app"user`,
    "app user",
    "app\non ~* +@all",
    "App",
    "1app",
    "",
  ])("refuses %j as a name or username", (value) => {
    expect(databaseNameFieldSchema.safeParse(value).success).toBe(false)
    expect(databaseUsernameSchema.safeParse(value).success).toBe(false)
    expect(databaseNameIssue("postgres", value)).not.toBeNull()
    expect(databaseUsernameIssue("redis", value)).not.toBeNull()
  })

  it("refuses names each engine keeps for itself", () => {
    expect(databaseUsernameIssue("mysql", "root")).not.toBeNull()
    expect(databaseUsernameIssue("mariadb", "root")).not.toBeNull()
    expect(databaseUsernameIssue("mariadb", "healthcheck")).not.toBeNull()
    expect(databaseUsernameIssue("postgres", "pg_app")).not.toBeNull()
    expect(databaseUsernameIssue("redis", "default")).not.toBeNull()
    expect(databaseNameIssue("mysql", "mysql")).not.toBeNull()
    expect(databaseNameIssue("postgres", "postgres")).not.toBeNull()
    // Only reserved on the engines that use them.
    expect(databaseUsernameIssue("mysql", "healthcheck")).toBeNull()
    expect(databaseUsernameIssue("postgres", "default")).toBeNull()
    expect(databaseUsernameIssue("postgres", "postgres")).toBeNull()
    expect(databaseNameIssue("postgres", "mysql")).toBeNull()
  })
})
