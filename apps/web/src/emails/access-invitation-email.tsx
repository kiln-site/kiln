import {
  EmailButton,
  EmailLink,
  EmailNote,
  EmailStrong,
  EmailText,
  KilnEmail,
} from "./kiln-email"

export interface AccessInvitationEmailProps {
  hearthUrl: string
  inviteUrl: string
  inviterName: string
  resourceName: string
  role: string
  scope: "database" | "instance" | "platform" | "relay"
}

const kindNoun = {
  database: "database",
  instance: "game server",
  relay: "Relay",
} as const

export function AccessInvitationEmail({
  hearthUrl,
  inviteUrl,
  inviterName,
  resourceName,
  role,
  scope,
}: AccessInvitationEmailProps) {
  return (
    <KilnEmail
      hearthUrl={hearthUrl}
      preview={
        scope === "platform"
          ? `${inviterName} invited you to Kiln`
          : `${inviterName} invited you to ${resourceName}`
      }
      title={scope === "platform" ? "Join Kiln" : `Join ${resourceName}`}
    >
      <EmailText>
        <EmailStrong>{inviterName}</EmailStrong>{" "}
        {scope === "platform" ? (
          <>invited you to Kiln as {role}.</>
        ) : (
          <>
            invited you to the {kindNoun[scope]}{" "}
            <EmailStrong>{resourceName}</EmailStrong> as {role}.
          </>
        )}
      </EmailText>
      <EmailButton href={inviteUrl}>Accept invitation</EmailButton>
      <EmailNote>
        The invitation expires in 7 days. If you weren&apos;t expecting it, you
        can ignore this email.
      </EmailNote>
      <EmailNote>
        Or open this link:
        <br />
        <EmailLink href={inviteUrl} />
      </EmailNote>
    </KilnEmail>
  )
}

AccessInvitationEmail.PreviewProps = {
  hearthUrl: "https://hearth.kiln.site/",
  inviteUrl: "https://hearth.kiln.site/invite?id=preview",
  inviterName: "Sam Rivera",
  resourceName: "Paper 1.21",
  role: "a member",
  scope: "instance",
} satisfies AccessInvitationEmailProps

export default AccessInvitationEmail
