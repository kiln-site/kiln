import type { ReactNode } from "react"
import type { Attachment } from "resend"
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email"

import kilnMark from "@/assets/branding/email-mark.png?inline"
import type { EmailTheme } from "../../scripts/email-theme"

declare const __KILN_EMAIL_THEME__: EmailTheme

// Every send attaches the logo inline, so it shows even when the recipient
// can't reach this Hearth.
export const kilnEmailAttachments: Array<Attachment> = [
  {
    content: Buffer.from(kilnMark.slice(kilnMark.indexOf(",") + 1), "base64"),
    contentId: "kiln-mark",
    contentType: "image/png",
    filename: "kiln.png",
  },
]

// Hearth's light colors, with a `-dark` variant of each for clients that honor
// prefers-color-scheme. Built from globals.css by vite.config.ts.
const tailwindConfig = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      colors: Object.fromEntries(
        Object.entries(__KILN_EMAIL_THEME__.light).map(([color, light]) => [
          color,
          {
            DEFAULT: light,
            dark: __KILN_EMAIL_THEME__.dark[color as keyof EmailTheme["dark"]],
          },
        ])
      ),
      fontFamily: {
        sans: [
          "Geist",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
}

export interface KilnEmailProps {
  children: ReactNode
  hearthUrl: string
  preview: string
  title: string
}

export function KilnEmail({
  children,
  hearthUrl,
  preview,
  title,
}: KilnEmailProps) {
  const hearth = new URL(hearthUrl)
  return (
    <Html lang="en">
      <Tailwind config={tailwindConfig}>
        <Head>
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=JetBrains+Mono:wght@500&display=swap"
          />
        </Head>
        {/* Body copies its style, but not its class, onto an inner cell, so the
            dark background also lives on the Section that fills it. */}
        <Body className="bg-card text-foreground dark:bg-card-dark m-0 font-sans">
          <Preview>{preview}</Preview>
          <Section className="bg-card dark:bg-card-dark px-6 py-12">
            <Container className="mx-auto w-full max-w-[480px]">
              <Img
                src="cid:kiln-mark"
                width="32"
                height="32"
                alt="Kiln"
              />
              <Heading
                as="h1"
                className="text-foreground dark:text-foreground-dark mt-8 mb-0 text-[22px] leading-[30px] font-semibold tracking-[-0.02em]"
              >
                {title}
              </Heading>
              {children}
              <Hr className="border-border dark:border-border-dark mt-10 mb-4 border-0 border-t border-solid" />
              <Link
                href={hearth.origin}
                className="text-muted-foreground dark:text-muted-foreground-dark font-mono text-[11px] leading-[16px] no-underline"
              >
                {hearth.host}
              </Link>
            </Container>
          </Section>
        </Body>
      </Tailwind>
    </Html>
  )
}

export function EmailText({ children }: { children: ReactNode }) {
  return (
    <Text className="text-muted-foreground dark:text-muted-foreground-dark mt-3 mb-0 text-[15px] leading-[24px]">
      {children}
    </Text>
  )
}

export function EmailStrong({ children }: { children: ReactNode }) {
  return (
    <strong className="text-foreground dark:text-foreground-dark font-semibold">
      {children}
    </strong>
  )
}

export function EmailNote({ children }: { children: ReactNode }) {
  return (
    <Text className="text-muted-foreground dark:text-muted-foreground-dark mt-6 mb-0 text-[13px] leading-[20px]">
      {children}
    </Text>
  )
}

export function EmailCode({ code }: { code: string }) {
  return (
    <Section className="border-border bg-surface-raised dark:border-border-dark dark:bg-surface-raised-dark mt-6 border border-solid">
      <Text className="text-foreground dark:text-foreground-dark m-0 py-4 pl-[10px] text-center font-mono text-[30px] leading-[36px] font-medium tracking-[0.32em]">
        {code}
      </Text>
    </Section>
  )
}

export function EmailButton({
  children,
  href,
}: {
  children: ReactNode
  href: string
}) {
  return (
    <Button
      href={href}
      className="text-primary-foreground dark:bg-primary-dark dark:text-primary-foreground-dark mt-6 box-border inline-block bg-primary px-5 py-3 text-[14px] leading-[20px] font-semibold no-underline"
    >
      {children}
    </Button>
  )
}

export function EmailLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground dark:text-muted-foreground-dark font-mono text-[11px] break-all underline"
    >
      {href}
    </Link>
  )
}
