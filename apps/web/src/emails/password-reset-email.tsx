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

export interface PasswordResetEmailProps {
  name: string
  resetUrl: string
}

export function PasswordResetEmail({
  name,
  resetUrl,
}: PasswordResetEmailProps) {
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
          <Preview>Reset your Kiln password</Preview>
          <Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-[#d9d0c4] bg-white">
            <Section className="border-b border-none border-solid border-[#e6ded4] px-8 py-6">
              <Text className="text-ember m-0 font-mono text-[11px] font-bold tracking-[0.18em] uppercase">
                Kiln · Account recovery
              </Text>
            </Section>
            <Section className="px-8 py-8">
              <Heading
                as="h1"
                className="text-ink m-0 text-[28px] leading-[34px]"
              >
                Reset your password
              </Heading>
              <Text className="text-smoke mt-5 text-[15px] leading-[24px]">
                Hi {name}, use the secure link below to choose a new password
                for your Kiln account.
              </Text>
              <Button
                href={resetUrl}
                className="bg-ember mt-5 box-border block rounded-lg px-5 py-3 text-center text-[14px] font-bold text-white no-underline"
              >
                Choose a new password
              </Button>
              <Text className="text-smoke mt-6 text-[12px] leading-[19px]">
                This link expires in 30 minutes and can only be used once. If
                you didn&apos;t request it, your password has not changed.
              </Text>
              <Hr className="my-6 border-0 border-t border-solid border-[#e6ded4]" />
              <Text className="m-0 font-mono text-[10px] leading-[16px] break-all text-[#8e877f]">
                {resetUrl}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

PasswordResetEmail.PreviewProps = {
  name: "Alex",
  resetUrl: "https://hearth.kiln.site/reset-password?token=preview",
} satisfies PasswordResetEmailProps

export default PasswordResetEmail
