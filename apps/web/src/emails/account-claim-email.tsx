import {
  EmailButton,
  EmailLink,
  EmailNote,
  EmailStrong,
  EmailText,
  KilnEmail,
} from "./kiln-email"

export interface AccountClaimEmailProps {
  claimUrl: string
  email: string
  hearthUrl: string
}

export function AccountClaimEmail({
  claimUrl,
  email,
  hearthUrl,
}: AccountClaimEmailProps) {
  return (
    <KilnEmail
      hearthUrl={hearthUrl}
      preview="Verify your email to set up your Kiln account"
      title="Set up your Kiln account"
    >
      <EmailText>
        Verify <EmailStrong>{email}</EmailStrong> and choose how you&apos;ll
        sign in.
      </EmailText>
      <EmailButton href={claimUrl}>Set up account</EmailButton>
      <EmailNote>
        The link expires in 30 minutes. If you didn&apos;t ask for this, you can
        ignore this email.
      </EmailNote>
      <EmailNote>
        Or open this link:
        <br />
        <EmailLink href={claimUrl} />
      </EmailNote>
    </KilnEmail>
  )
}

AccountClaimEmail.PreviewProps = {
  claimUrl: "https://hearth.kiln.site/claim?token=preview",
  email: "alex@example.com",
  hearthUrl: "https://hearth.kiln.site/",
} satisfies AccountClaimEmailProps

export default AccountClaimEmail
