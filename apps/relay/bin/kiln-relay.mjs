#!/nodejs/bin/node

// A backup's password needs no Relay, so none is started to make it.
await import(
  process.argv[2] === "backup-password"
    ? "/app/dist/src/backup-password.mjs"
    : "/app/dist/src/index.mjs"
)
