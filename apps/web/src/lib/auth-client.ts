import { passkeyClient } from "@better-auth/passkey/client"
import {
  adminClient,
  emailOTPClient,
  twoFactorClient,
} from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import { passwordConfirmationClient } from "@/lib/password-confirmation-client"

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    emailOTPClient(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    passkeyClient(),
    passwordConfirmationClient(),
  ],
})
