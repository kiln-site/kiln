import { createServerFn } from "@tanstack/react-start"
import {
  cliAccessDurationSchema,
  cliAccessModeSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  approveCliAuthorizationEffect,
  denyCliAuthorizationEffect,
  inspectCliAuthorizationEffect,
  listCliCredentialsEffect,
  revokeCliCredentialEffect,
} from "@/effect/cli-access"
import { runAppEffect } from "@/effect/runtime"
import { cliDefaultAccessDays } from "@/lib/environment"
import { requireVerifiedUser, requireEligibleResourceUser } from "@/server/auth"

const userCodeInputSchema = z.object({
  userCode: z.string().min(8).max(12),
})

export const getCliAuthorizationRequest = createServerFn({ method: "GET" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }) => {
    await requireVerifiedUser()
    const inspection = await runAppEffect(
      "cli.device.inspect",
      inspectCliAuthorizationEffect(data.userCode).pipe(
        Effect.match({
          onFailure: (cause) => ({
            request: null,
            requestError: cause.message,
          }),
          onSuccess: (request) => ({ request, requestError: null }),
        })
      )
    )
    return {
      defaultAccessDays: cliDefaultAccessDays(),
      ...inspection,
    }
  })

export const approveCliAuthorization = createServerFn({ method: "POST" })
  .validator(
    userCodeInputSchema.extend({
      duration: cliAccessDurationSchema,
      mode: cliAccessModeSchema,
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return runAppEffect(
      "cli.device.approve",
      approveCliAuthorizationEffect({ ...data, user })
    )
  })

export const denyCliAuthorization = createServerFn({ method: "POST" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }) => {
    const user = await requireVerifiedUser()
    return runAppEffect(
      "cli.device.deny",
      denyCliAuthorizationEffect({ ...data, user })
    )
  })

export const getCliCredentials = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireVerifiedUser()
    return {
      credentials: await runAppEffect(
        "cli.credentials.list",
        listCliCredentialsEffect(user)
      ),
      defaultAccessDays: cliDefaultAccessDays(),
    }
  }
)

export const revokeCliCredential = createServerFn({ method: "POST" })
  .validator(z.object({ credentialId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireVerifiedUser()
    return runAppEffect(
      "cli.credentials.revoke",
      revokeCliCredentialEffect({ ...data, user })
    )
  })
