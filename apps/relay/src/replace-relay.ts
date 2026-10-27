// Run by the installer from the Relay image it downloaded, in a short-lived
// container with the Relay's volumes, whenever it finds a Relay already
// installed: `replace-relay.mjs <container> <image>` replaces that Relay
// with one from this image, keeping its settings and data. Lines starting
// `kiln:` say why it didn't, for the installer to show.
import { Effect } from "effect"

import { DockerEngine } from "./docker-engine.js"
import { replaceRelayEffect } from "./system-updates.js"

const [targetContainer = "", image = ""] = process.argv.slice(2)

await Effect.runPromise(
  replaceRelayEffect(new DockerEngine("/var/run/docker.sock"), {
    image,
    targetContainer,
  }).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.sync(() => {
          console.log(`kiln: ${cause.message}`)
          process.exitCode = 1
        }),
      onSuccess: (replacement) =>
        Effect.sync(() => {
          if (replacement.status === "newer") {
            console.log(
              `kiln: The Relay is on ${replacement.current}, newer than ${replacement.version}, so it stays as it is.`
            )
            process.exitCode = 1
          } else if (replacement.operation.status === "failed") {
            console.log(`kiln: ${replacement.operation.error}`)
            process.exitCode = 1
          } else {
            console.log(
              `Replaced ${replacement.operation.targetContainer} with ${replacement.operation.version}`
            )
          }
        }),
    })
  )
)
