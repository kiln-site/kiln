import { cliDeviceTokenResponseSchema } from "@workspace/contracts/cli"
import { Effect } from "effect"
import Constants from "expo-constants"
import * as Crypto from "expo-crypto"
import * as WebBrowser from "expo-web-browser"

import { HearthError, publicRequest, type HearthSession } from "./hearth"

// The release app and Kiln Dev have their own schemes; Hearth accepts both.
const scheme = Constants.expoConfig?.scheme
const REDIRECT = `${(Array.isArray(scheme) ? scheme[0] : scheme) ?? "kiln"}://auth`

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const failed = (code: string, message: string, cause?: unknown) =>
  HearthError.make({ code, message, status: 0, retryable: true, cause })

/**
 * Signs in on Hearth's own sign-in page, in a browser sheet that shares
 * nothing with Safari, so it always asks who you are. Hearth sends the sheet
 * back to the app with a one-time code; the code redeems only with the
 * verifier this function kept, whose hash went out with the sign-in.
 *
 * Returns null when the person closes the sheet.
 */
export const signInWithHearth = Effect.fn("SignIn.browser")(function* (
  origin: string,
  deviceName: string
) {
  const verifier = hex(Crypto.getRandomBytes(32))
  const state = hex(Crypto.getRandomBytes(16))
  const challenge = yield* Effect.tryPromise({
    try: () =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.HEX,
      }),
    catch: (cause) => failed("crypto", "Couldn't prepare the sign-in.", cause),
  })

  const page = new URL("/mobile/sign-in", origin)
  page.searchParams.set("challenge", challenge.toLowerCase())
  page.searchParams.set("state", state)
  page.searchParams.set("name", deviceName)
  page.searchParams.set("redirect", REDIRECT)
  const result = yield* Effect.tryPromise({
    try: () =>
      WebBrowser.openAuthSessionAsync(page.toString(), REDIRECT, {
        preferEphemeralSession: true,
      }),
    catch: (cause) =>
      failed("browser", "Couldn't open the sign-in page.", cause),
  })
  if (result.type !== "success") return null

  const returned = new URL(result.url)
  const code = returned.searchParams.get("code")
  if (!code || returned.searchParams.get("state") !== state) {
    return yield* failed("invalid_state", "The sign-in didn't come back intact. Try again.")
  }

  const token = yield* publicRequest(
    origin,
    "/api/cli/auth/mobile/token",
    cliDeviceTokenResponseSchema,
    { method: "POST", body: JSON.stringify({ code, verifier }) }
  )
  return {
    url: origin,
    token: token.accessToken,
    credential: token.credential,
  } satisfies HearthSession
})
