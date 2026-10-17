import { createServerFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { Schema } from "effect"

import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  readInfraRelayOptions,
  readInfraServerDirectory,
} from "@/server/infra-directory.server"

export const getInfraServerDirectory = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireEligibleResourceUser()
  setResponseHeader("Cache-Control", "no-store")
  return runAppEffect(
    "Infra.directory.servers",
    readInfraServerDirectory(user),
    { signal: getRequest().signal }
  )
})

export const getInfraRelayOptions = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(Schema.Literals(["app", "database"])))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    setResponseHeader("Cache-Control", "no-store")
    return runAppEffect("Infra.directory", readInfraRelayOptions(user, data), {
      signal: getRequest().signal,
    })
  })
