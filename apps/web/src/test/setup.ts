// Modules such as `@/lib/database` read DB_* when imported but connect
// lazily, so placeholders keep tests that never query MySQL offline.
process.env.DB_HOST ??= "127.0.0.1"
process.env.DB_PORT ??= "3306"
process.env.DB_NAME ??= "kiln_test"
process.env.DB_USERNAME ??= "kiln"
process.env.DB_PASSWORD ??= "kiln"

// With KILN_TEST_MYSQL=1, each Vitest worker gets its own database so files
// running in parallel never see each other's rows.
if (process.env.KILN_TEST_MYSQL === "1") {
  if (!process.env.DB_NAME.endsWith("_test")) {
    throw new Error("KILN_TEST_MYSQL needs a disposable DB_NAME ending in _test")
  }
  process.env.DB_NAME = `${process.env.DB_NAME}_${process.env.VITEST_POOL_ID ?? "1"}`
}
