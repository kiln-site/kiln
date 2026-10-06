import {
  Body,
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

export interface AuthCodeEmailProps {
  code: string
  purpose: "change-email" | "email-verification" | "forget-password" | "sign-in"
}

const copy = {
  "change-email": {
    preview: "Your Kiln email change code",
    eyebrow: "Email change",
    title: "Confirm your new email",
    description: "Enter this code in Kiln to confirm your new email address.",
  },
  "email-verification": {
    preview: "Your Kiln email verification code",
    eyebrow: "Identity check",
    title: "Verify your email",
    description: "Enter this code in Kiln to finish setting up your account.",
  },
  "forget-password": {
    preview: "Your Kiln password reset code",
    eyebrow: "Account recovery",
    title: "Reset your password",
    description: "Enter this code in Kiln to choose a new password.",
  },
  "sign-in": {
    preview: "Your Kiln sign-in code",
    eyebrow: "Secure sign in",
    title: "Sign in to Kiln",
    description: "Enter this code in Kiln to continue.",
  },
} as const

export function AuthCodeEmail({ code, purpose }: AuthCodeEmailProps) {
  const content = copy[purpose]
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
          <Preview>{content.preview}</Preview>
          <Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-[#d9d0c4] bg-white">
            <Section className="border-none border-b border-solid border-[#e6ded4] px-8 py-6">
              <Text className="m-0 font-mono text-[11px] font-bold tracking-[0.18em] text-ember uppercase">
                Kiln · {content.eyebrow}
              </Text>
            </Section>
            <Section className="px-8 py-8">
              <Heading as="h1" className="m-0 text-[28px] leading-[34px] text-ink">
                {content.title}
              </Heading>
              <Text className="mt-5 text-[15px] leading-[24px] text-smoke">
                {content.description}
              </Text>
              <Text className="my-6 rounded-lg bg-[#f4efe7] px-5 py-4 text-center font-mono text-[30px] font-bold tracking-[0.28em] text-ink">
                {code}
              </Text>
              <Text className="text-[12px] leading-[19px] text-smoke">
                This code expires in 10 minutes and can only be used once.
              </Text>
              <Hr className="my-6 border-0 border-t border-solid border-[#e6ded4]" />
              <Text className="m-0 text-[12px] leading-[19px] text-[#8e877f]">
                If you didn&apos;t request this, you can safely ignore this email.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

AuthCodeEmail.PreviewProps = {
  code: "381204",
  purpose: "email-verification",
} satisfies AuthCodeEmailProps

export default AuthCodeEmail
