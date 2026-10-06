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

export interface VerificationEmailProps {
  name: string
  verificationUrl: string
}

export function VerificationEmail({
  name,
  verificationUrl,
}: VerificationEmailProps) {
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
        <Body className="m-0 bg-paper px-4 py-10 font-sans text-ink">
          <Preview>Verify your email to finish setting up Kiln</Preview>
          <Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-[#d9d0c4] bg-white">
            <Section className="border-none border-b border-solid border-[#e6ded4] px-8 py-6">
              <Text className="m-0 font-mono text-[11px] font-bold tracking-[0.18em] text-ember uppercase">
                Kiln · Identity check
              </Text>
            </Section>
            <Section className="px-8 py-8">
              <Heading as="h1" className="m-0 text-[28px] leading-[34px] text-ink">
                Seal your account
              </Heading>
              <Text className="mt-5 text-[15px] leading-[24px] text-smoke">
                Hi {name}, verify this email address before it can be used to
                access your Minecraft control plane.
              </Text>
              <Button
                href={verificationUrl}
                className="mt-5 box-border block rounded-lg bg-ember px-5 py-3 text-center text-[14px] font-bold text-white no-underline"
              >
                Verify email address
              </Button>
              <Text className="mt-6 text-[12px] leading-[19px] text-smoke">
                If you didn&apos;t create this account, you can safely ignore
                this message.
              </Text>
              <Hr className="my-6 border-0 border-t border-solid border-[#e6ded4]" />
              <Text className="m-0 break-all font-mono text-[10px] leading-[16px] text-[#8e877f]">
                {verificationUrl}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

VerificationEmail.PreviewProps = {
  name: "Alex",
  verificationUrl: "https://hearth.kiln.site/api/auth/verify-email?token=preview",
} satisfies VerificationEmailProps

export default VerificationEmail
