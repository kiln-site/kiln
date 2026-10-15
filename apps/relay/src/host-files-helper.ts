// Runs in a short-lived container beside the Relay, started by
// `HostFiles.mount`, to recreate the Relay with the host's filesystem
// mounted. The outcome is left in a file for the new or restored Relay.
import { rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"

import { DockerEngine } from "./docker-engine.js"
import { mountHostFilesEffect, type MountResult } from "./host-files.js"
import { promiseEffect } from "./effect/promise.js"

const environment = (name: string) => process.env[name]?.trim() ?? ""
const resultPath = environment("KILN_HOST_FILES_RESULT")

await Effect.runPromise(
  Effect.sleep("2 seconds").pipe(
    // The Relay answers the request that started this helper first.
    Effect.andThen(
      mountHostFilesEffect(
        new DockerEngine(environment("KILN_HOST_FILES_DOCKER_SOCKET")),
        {
          relay: environment("KILN_HOST_FILES_RELAY"),
          root: environment("KILN_HOST_FILES_ROOT"),
          disableLabel: environment("KILN_HOST_FILES_DISABLE_LABEL") === "1",
        }
      )
    ),
    Effect.matchEffect({
      onFailure: (cause) => {
        const result: MountResult = { error: cause.message }
        return promiseEffect(() =>
          writeFile(resultPath, `${JSON.stringify(result)}\n`)
        )
      },
      onSuccess: () => promiseEffect(() => rm(resultPath, { force: true })),
    }),
    Effect.catch((cause) =>
      Effect.logError("Could not record the host files mount", cause)
    )
  )
)
