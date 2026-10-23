#!/nodejs/bin/node

// node:sqlite is still flagged experimental in Node 24, so every Relay
// process (the daemon and each `kiln-relay` command) printed a warning
// operators can't act on. Drop only that one, before the Relay loads it.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const type =
    typeof rest[0] === "string" ? rest[0] : (rest[0] && rest[0].type) || ""
  const message = typeof warning === "string" ? warning : warning?.message
  if (type === "ExperimentalWarning" && /SQLite/u.test(message ?? "")) return
  emitWarning(warning, ...rest)
}

await import("/app/dist/src/index.mjs")
