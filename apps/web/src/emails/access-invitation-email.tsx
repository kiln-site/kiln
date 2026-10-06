import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email"

export interface AccessInvitationEmailProps {
  inviteUrl: string
  inviterName: string
  resourceName: string
  role: string
  scope: "database" | "instance" | "platform" | "relay"
}

export function AccessInvitationEmail({
  inviteUrl,
  inviterName,
  resourceName,
  role,
  scope,
}: AccessInvitationEmailProps) {
  return (
    <Html lang="en">
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: {
                ember: "#dc6b38",
                ink: "#181614",
                smoke: "#716b64",
                paper: "#f4efe7",
              },
            },
          },
        }}
      >
        <Head />
        <Body className="bg-paper text-ink m-0 px-4 py-10 font-sans">
          <Preview>
            {inviterName} invited you to {resourceName} in Kiln
          </Preview>
          <Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-[#d9d0c4] bg-white">
            <Section className="border-b border-none border-solid border-[#e6ded4] px-8 py-6">
              <Text className="text-ember m-0 font-mono text-[11px] font-bold tracking-[0.18em] uppercase">
                Kiln · Access invitation
              </Text>
            </Section>
            <Section className="px-8 py-8">
              <Heading
                as="h1"
                className="text-ink m-0 text-[28px] leading-[34px]"
              >
                You&apos;re invited
              </Heading>
              <Text className="text-smoke mt-5 text-[15px] leading-[24px]">
                {scope === "platform"
                  ? `${inviterName} invited you to Kiln as ${role}.`
                  : `${inviterName} invited you to the ${scope} ${resourceName} as ${role}.`}{" "}
                Open this link to continue with this email address.
              </Text>
              <Button
                href={inviteUrl}
                className="bg-ember mt-5 box-border block rounded-lg px-5 py-3 text-center text-[14px] font-bold text-white no-underline"
              >
                Continue
              </Button>
              <Text className="text-smoke mt-6 text-[12px] leading-[19px]">
                This invitation expires in seven days. If you weren&apos;t
                expecting it, you can safely ignore this message.
              </Text>
              <Hr className="my-6 border-0 border-t border-solid border-[#e6ded4]" />
              <Text className="m-0 font-mono text-[10px] leading-[16px] break-all text-[#8e877f]">
                {inviteUrl}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

AccessInvitationEmail.PreviewProps = {
  inviteUrl: "https://hearth.kiln.site/invite?token=preview",
  inviterName: "Kiln operator",
  resourceName: "Paper 1.21",
  role: "operator",
  scope: "instance",
} satisfies AccessInvitationEmailProps

export default AccessInvitationEmail
