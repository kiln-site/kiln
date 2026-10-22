import {
  EmailCode,
  EmailNote,
  EmailStrong,
  EmailText,
  KilnEmail,
} from "./kiln-email"

export interface AuthCodeEmailProps {
  code: string
  email: string
  hearthUrl: string
  purpose: "change-email" | "email-verification" | "forget-password" | "sign-in"
}

const copy = {
  "change-email": {
    preview: "is your Kiln email change code",
    title: "Confirm your new email",
    description: "Enter this code in Kiln to change your email to",
    ignore: "If you didn't ask for this, your email stays the same.",
  },
  "email-verification": {
    preview: "is your Kiln verification code",
    title: "Verify your email",
    description: "Enter this code in Kiln to verify",
    ignore: "If you didn't create a Kiln account, you can ignore this email.",
  },
  "forget-password": {
    preview: "is your Kiln password reset code",
    title: "Reset your password",
    description: "Enter this code in Kiln to reset the password for",
    ignore: "If you didn't ask for this, your password stays the same.",
  },
  "sign-in": {
    preview: "is your Kiln sign-in code",
    title: "Sign in to Kiln",
    description: "Enter this code in Kiln to sign in as",
    ignore: "If you didn't try to sign in, you can ignore this email.",
  },
} as const

export function AuthCodeEmail({
  code,
  email,
  hearthUrl,
  purpose,
}: AuthCodeEmailProps) {
  const content = copy[purpose]
  return (
    <KilnEmail
      hearthUrl={hearthUrl}
      preview={`${code} ${content.preview}`}
      title={content.title}
    >
      <EmailText>
        {content.description} <EmailStrong>{email}</EmailStrong>.
      </EmailText>
      <EmailCode code={code} />
      <EmailNote>The code expires in 10 minutes. {content.ignore}</EmailNote>
    </KilnEmail>
  )
}

AuthCodeEmail.PreviewProps = {
  code: "381204",
  email: "alex@example.com",
  hearthUrl: "https://hearth.kiln.site/",
  purpose: "email-verification",
} satisfies AuthCodeEmailProps

export default AuthCodeEmail
