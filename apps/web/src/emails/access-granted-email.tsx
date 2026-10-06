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

export interface AccessGrantedEmailProps {
  actionUrl: string
  grantedBy: string
  resourceName: string
  role: string
  scope: "database" | "instance" | "platform" | "relay"
}

export function AccessGrantedEmail({
  actionUrl,
  grantedBy,
  resourceName,
  role,
  scope,
}: AccessGrantedEmailProps) {
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
            {grantedBy} added you to {resourceName} in Kiln
          </Preview>
          <Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-[#d9d0c4] bg-white">
            <Section className="border-b border-none border-solid border-[#e6ded4] px-8 py-6">
              <Text className="text-ember m-0 font-mono text-[11px] font-bold tracking-[0.18em] uppercase">
                Kiln · Access granted
              </Text>
            </Section>
            <Section className="px-8 py-8">
              <Heading
                as="h1"
                className="text-ink m-0 text-[28px] leading-[34px]"
              >
                Your access is ready
              </Heading>
              <Text className="text-smoke mt-5 text-[15px] leading-[24px]">
                {scope === "platform"
                  ? `${grantedBy} gave your Kiln account ${role} access.`
                  : `${grantedBy} added your existing Kiln account to the ${scope} ${resourceName} as ${role}.`}{" "}
                You can use this access immediately.
              </Text>
              <Button
                href={actionUrl}
                className="bg-ember mt-5 box-border block rounded-lg px-5 py-3 text-center text-[14px] font-bold text-white no-underline"
              >
                Open Kiln
              </Button>
              <Text className="text-smoke mt-6 text-[12px] leading-[19px]">
                If you weren&apos;t expecting this change, contact your Kiln
                administrator.
              </Text>
              <Hr className="my-6 border-0 border-t border-solid border-[#e6ded4]" />
              <Text className="m-0 font-mono text-[10px] leading-[16px] break-all text-[#8e877f]">
                {actionUrl}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

AccessGrantedEmail.PreviewProps = {
  actionUrl: "https://hearth.kiln.site/",
  grantedBy: "Kiln operator",
  resourceName: "Paper 1.21",
  role: "operator",
  scope: "instance",
} satisfies AccessGrantedEmailProps

export default AccessGrantedEmail
