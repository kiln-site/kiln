import { createServerFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"

import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"
import { readInfraServerDirectory } from "@/server/infra-directory.server"

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
