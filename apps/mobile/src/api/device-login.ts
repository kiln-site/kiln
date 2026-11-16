import {
  cliDeviceCodeResponseSchema,
  cliDeviceTokenResponseSchema,
} from "@workspace/contracts/cli"
import { Duration, Effect, Schedule } from "effect"

import { HearthError, publicRequest, type HearthSession } from "./hearth"

export type DeviceCode = typeof cliDeviceCodeResponseSchema._output

/**
 * Starts the same device sign-in the CLI uses: Hearth issues a code, the
 * person approves it in a browser where they are signed in, and the app
 * polls until Hearth hands over a bearer token.
 */
export const startDeviceLogin = Effect.fn("DeviceLogin.start")(function* (
  origin: string,
  deviceName: string
) {
  return yield* publicRequest(
    origin,
    "/api/cli/auth/device",
    cliDeviceCodeResponseSchema,
    { method: "POST", body: JSON.stringify({ name: deviceName }) }
  )
})

const pollOnce = (origin: string, code: DeviceCode) =>
  publicRequest(origin, "/api/cli/auth/token", cliDeviceTokenResponseSchema, {
    method: "POST",
    body: JSON.stringify({ deviceCode: code.deviceCode }),
  })

const MAX_INTERVAL = Duration.seconds(15)

/** Polls until the code is approved, denied, or expires. */
export const awaitDeviceToken = Effect.fn("DeviceLogin.await")(function* (
  origin: string,
  code: DeviceCode
) {
  let interval = Duration.seconds(code.interval)
  const token = yield* pollOnce(origin, code).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (error.code === "slow_down")
          interval = Duration.min(
            Duration.sum(interval, Duration.seconds(2)),
            MAX_INTERVAL
          )
      })
    ),
    Effect.retry({
      while: (error) =>
        error.code === "authorization_pending" || error.code === "slow_down",
      schedule: Schedule.spaced(Duration.seconds(code.interval)).pipe(
        Schedule.modifyDelay(() => Effect.succeed(interval))
      ),
    }),
    Effect.timeoutOrElse({
      duration: Duration.millis(
        Math.max(0, Date.parse(code.expiresAt) - Date.now())
      ),
      orElse: () =>
        Effect.fail(
          HearthError.make({
            code: "expired_token",
            message: "The sign-in code expired. Start again.",
            status: 0,
            retryable: true,
          })
        ),
    })
  )
  return {
    url: origin,
    token: token.accessToken,
    credential: token.credential,
  } satisfies HearthSession
})
