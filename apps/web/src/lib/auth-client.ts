import { passkeyClient } from "@better-auth/passkey/client"
import {
  adminClient,
  emailOTPClient,
  twoFactorClient,
} from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import {
  accountChangedMessage,
  getRenderedAccount,
  renderedAccountHeader,
} from "@/lib/browser-accounts"
import { passwordConfirmationClient } from "@/lib/password-confirmation-client"
import {
  isSessionRotating,
  sessionRotationSettled,
} from "@/lib/session-rotation"

export const authClient = createAuthClient({
  // Better Auth refuses calls from a tab that still renders an account the
  // browser has switched away from; that tab reloads as the active account.
  fetchOptions: {
    async onRequest(context) {
      // Refetched on focus. Answering the dying cookie, it would clear the new
      // one while the session is being replaced.
      if (String(context.url).includes("/get-session"))
        await sessionRotationSettled()
      const account = getRenderedAccount()
      if (account !== null) context.headers.set(renderedAccountHeader, account)
      return context
    },
    onError(context) {
      if (
        context.error.message === accountChangedMessage &&
        !isSessionRotating()
      )
        window.location.reload()
    },
  },
  plugins: [
    adminClient(),
    emailOTPClient(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    passkeyClient(),
    passwordConfirmationClient(),
  ],
})
