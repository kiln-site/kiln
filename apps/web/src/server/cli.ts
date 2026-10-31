import { createServerFn } from "@tanstack/react-start"
import {
  cliAccessDurationSchema,
  cliAccessModeSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  inspectCliAuthorizationEffect,
  listCliCredentialsEffect,
} from "@/effect/cli-access"
import { runAppEffect } from "@/effect/runtime"
import { cliDefaultAccessDays } from "@/lib/environment"
import { runOperationPromise } from "@/operations/operation"
import {
  approveCliAuthorizationOperation,
  denyCliAuthorizationOperation,
  revokeCliCredentialOperation,
} from "@/server/account-access.server"
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
  .handler(async ({ data }) =>
    runOperationPromise(approveCliAuthorizationOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const denyCliAuthorization = createServerFn({ method: "POST" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(denyCliAuthorizationOperation, data, {
      user: await requireVerifiedUser(),
    })
  )

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
  .handler(async ({ data }) =>
    runOperationPromise(revokeCliCredentialOperation, data, {
      user: await requireVerifiedUser(),
    })
  )
