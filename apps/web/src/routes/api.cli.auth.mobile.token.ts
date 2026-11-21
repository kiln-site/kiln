import { createFileRoute } from "@tanstack/react-router"
import { cliMobileTokenRequestSchema } from "@workspace/contracts"
import { Effect } from "effect"

import { redeemMobileSignInEffect } from "@/effect/cli-access"
import { CliAccessError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { cliFailureResponse, cliJsonResponse } from "@/lib/cli-http"

export const Route = createFileRoute("/api/cli/auth/mobile/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const effect = Effect.tryPromise({
          try: () => request.json(),
          catch: (cause) => invalidBody(cause),
        }).pipe(
          Effect.flatMap((body) =>
            Effect.try({
              try: () => cliMobileTokenRequestSchema.parse(body),
              catch: invalidBody,
            })
          ),
          Effect.flatMap(redeemMobileSignInEffect),
          Effect.match({
            onFailure: cliFailureResponse,
            onSuccess: (value) => cliJsonResponse(value),
          })
        )
        return runAppEffect("cli.http.mobile.redeem", effect)
      },
    },
  },
})

function invalidBody(cause: unknown) {
  return CliAccessError.make({
    code: "invalid_request",
    message: "A sign-in code and its verifier are required.",
    retryable: false,
    cause,
  })
}
