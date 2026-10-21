import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  Braces,
  CalendarClock,
  Database,
  DatabaseBackup,
  FolderTree,
  Globe,
  History,
  RefreshCw,
  Search,
  Share2,
  SquareTerminal,
  UserCog,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { socialLinks } from "@/lib/social-links"

import { CyclingWord } from "~/components/cycling-word"
import { ComingSoon } from "~/components/coming-soon"
import { ClientDemo } from "~/components/demos/client-demo"
import { BrandSvg } from "~/components/brand-svg"
import { KindsSection } from "~/components/kinds-section"
import {
  sendFilesDemoCommand,
  type FilesDemoCommand,
} from "~/components/demos/files-demo-commands"
import { signUpUrl } from "~/lib/plans"
import { brandMarks } from "~/lib/brand-marks"
import { comingSoon } from "~/lib/coming-soon"
import { newTab } from "~/lib/new-tab"
import { pageHead, siteName, siteStructuredData, siteUrlOf } from "~/lib/seo"
import { useSiteConfig } from "~/lib/use-site-config"

const HearthDemo = React.lazy(() => import("~/components/demos/hearth-demo"))
const OverviewDemo = React.lazy(
  () => import("~/components/demos/overview-demo")
)

export const Route = createFileRoute("/")({
  head: ({ matches }) => ({
    ...pageHead({ matches, path: "/", title: siteName }),
    scripts: [
      {
        type: "application/ld+json",
        children: siteStructuredData(
          siteUrlOf(matches),
          Object.values(socialLinks).map((link) => link.href)
        ),
      },
    ],
  }),
  component: HomePage,
})

function HomePage() {
  return (
    <>
      <Hero />
      <Kinds />
      <Editor />
      <Relays />
      <Features />
      <SelfHost />
    </>
  )
}

const heroWords = [
  "game servers",
  "apps",
  "Docker",
  "databases",
  "your VPS",
  "everything",
]

function Hero() {
  const { docsUrl, hearthUrl } = useSiteConfig()
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_80%_60%_at_30%_0%,black,transparent)] bg-[size:64px_64px]"
      />
      <div className="site-container relative pt-14 pb-16 sm:pt-24 sm:pb-24">
        <div className="grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-12">
          <h1 className="site-display lg:col-span-7">
            <span className="sr-only">
              The panel for game servers, apps, Docker, databases, your VPS, and
              more
            </span>
            <span aria-hidden="true">The panel for</span>
            <span className="text-primary">
              <CyclingWord words={heroWords} />
            </span>
          </h1>
          <div className="lg:col-span-5 lg:pb-2">
            <p className="site-lede max-w-md text-muted-foreground">
              100% free and open source.
              <br />
              Your machines, one panel for all of it.
            </p>
            {comingSoon.signUp ? (
              // Nothing to click until sign-up opens.
              <p className="type-label mt-6 inline-flex h-11 items-center border border-border bg-card px-5 text-[0.9375rem] text-muted-foreground">
                Coming soon
              </p>
            ) : (
              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild className="h-11 px-5 text-[0.9375rem]">
                  <a href={signUpUrl(hearthUrl)}>Get started</a>
                </Button>
                <ComingSoon soon={comingSoon.docs} label="Read the docs">
                  <Button
                    asChild
                    variant="outline"
                    className="h-11 px-5 text-[0.9375rem]"
                  >
                    <a href={docsUrl} {...newTab}>
                      Read the docs
                    </a>
                  </Button>
                </ComingSoon>
              </div>
            )}
          </div>
        </div>

        <figure className="mt-12 sm:mt-16">
          <ClientDemo
            fallback={
              <div className="flex flex-col gap-3">
                <DemoFrame
                  label="Opening Hearth…"
                  className="h-[40rem] sm:h-[44rem]"
                />
                <div className="h-4" />
              </div>
            }
          >
            <HearthDemo view="console" />
          </ClientDemo>
        </figure>
      </div>
    </section>
  )
}

// Holds a demo's place while it loads.
function DemoFrame({ className, label }: { className: string; label: string }) {
  return (
    <div
      className={`grid place-items-center border border-border bg-card ${className}`}
    >
      <p className="type-support text-muted-foreground">{label}</p>
    </div>
  )
}

function SectionHeading({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="max-w-2xl">
      <h2 className="site-title">{title}</h2>
      {children ? (
        <p className="site-lede mt-4 text-muted-foreground">{children}</p>
      ) : null}
    </div>
  )
}

function Kinds() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <SectionHeading title="Everything you run, in one panel">
          Each in its own container, on a machine you choose.
        </SectionHeading>

        <KindsSection />
      </div>
    </section>
  )
}

// Each opens its part of the files demo below, except share.
const editorFeatures: Array<{
  command: FilesDemoCommand | null
  icon: typeof FolderTree
  label: string
}> = [
  { command: "open-tree", icon: FolderTree, label: "File tree" },
  { command: "search", icon: Search, label: "Search files" },
  { command: null, icon: Share2, label: "One-click share" },
  { command: "open-nbt", icon: Braces, label: "View and edit NBT" },
  { command: "open-sqlite", icon: Database, label: "View and edit SQLite" },
]

function Editor() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <SectionHeading title="A file editor in your browser">
          Browse, edit, and share every file on your servers.
        </SectionHeading>
        <ul className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
          {editorFeatures.map(({ command, icon: Icon, label }) => (
            <li key={label}>
              {command ? (
                <button
                  type="button"
                  className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                  onClick={() => sendFilesDemoCommand(command)}
                >
                  <Icon className="size-[18px] shrink-0 text-primary" />
                  {label}
                </button>
              ) : (
                <span className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-foreground">
                  <Icon className="size-[18px] shrink-0 text-primary" />
                  {label}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <ClientDemo
            fallback={
              <DemoFrame
                label="Opening Hearth…"
                className="h-[40rem] sm:h-[44rem]"
              />
            }
            whenVisible
          >
            <HearthDemo view="files" />
          </ClientDemo>
        </div>
      </div>
    </section>
  )
}

function Relays() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <SectionHeading title="Every machine becomes a Relay">
          Run the Relay with Docker on a rented server, a spare mini PC, or the
          computer under your desk. Hearth pairs with it, and your browser
          streams consoles and files straight from it.
        </SectionHeading>

        <figure className="mt-14">
          <ClientDemo
            fallback={
              <DemoFrame
                label="Opening the map…"
                className="h-[30rem] sm:h-[38rem]"
              />
            }
          >
            <OverviewDemo />
          </ClientDemo>
          <figcaption className="type-support mt-3 max-w-xl text-muted-foreground">
            Hearth’s map of a fleet. Choose a Relay to see what runs on it and
            how it connects, or drag to look around.
          </figcaption>
        </figure>
      </div>
    </section>
  )
}

const features: Array<{
  description: string
  icon: React.ReactNode
  title: string
}> = [
  {
    icon: <DatabaseBackup />,
    title: "Backups",
    description:
      "Scheduled backups to S3-compatible storage, restored in place.",
  },
  {
    icon: <CalendarClock />,
    title: "Schedules",
    description: "Restart, back up, or run a command on a timetable.",
  },
  {
    icon: <UserCog />,
    title: "Access",
    description: "Invite people and choose what they can do on each instance.",
  },
  {
    icon: <History />,
    title: "Activity",
    description: "A record of who changed what, and when.",
  },
  {
    icon: <SquareTerminal />,
    title: "Command line",
    description: "Script power, files, and backups with the kiln CLI.",
  },
  {
    icon: <BrandSvg mark={brandMarks.tailscale} className="size-5" />,
    title: "Tailscale",
    description: "Reach instances privately over your tailnet.",
  },
  {
    icon: <Globe />,
    title: "Domains",
    description: "Point your own domains at apps, with HTTPS.",
  },
  {
    icon: <RefreshCw />,
    title: "Updates",
    description: "Update Hearth and every Relay from the panel.",
  },
]

function Features() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <SectionHeading title="And the rest of running a server" />
        <ul className="mt-12 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <li
              key={feature.title}
              className="group relative flex flex-col gap-5 overflow-hidden bg-background p-6"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_70%_at_0%_0%,hsl(var(--accent-hue)_var(--accent-saturation)_58%/0.06),transparent)] opacity-0 transition-opacity group-hover:opacity-100"
              />
              <span className="relative grid size-10 place-items-center border border-primary/25 bg-primary/10 text-primary [&_svg]:size-5">
                {feature.icon}
              </span>
              <div className="relative">
                <h3 className="font-semibold tracking-[-0.01em] text-foreground">
                  {feature.title}
                </h3>
                <p className="type-support mt-1.5 text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function SelfHost() {
  const { docsUrl } = useSiteConfig()
  return (
    <section className="border-t border-border">
      <div className="site-container grid gap-12 py-20 sm:py-28 lg:grid-cols-12 lg:items-center lg:gap-16">
        <div className="lg:col-span-5">
          <SectionHeading title="Yours to run">
            Open source under AGPL-3.0. Host it yourself, or let us run the
            panel.
          </SectionHeading>
          <div className="mt-8 flex flex-wrap gap-3">
            <ComingSoon soon={comingSoon.docs} label="Install Kiln">
              <Button asChild className="h-11 px-5 text-[0.9375rem]">
                <a href={docsUrl} {...newTab}>
                  Install Kiln
                </a>
              </Button>
            </ComingSoon>
            <Button
              asChild
              variant="outline"
              className="h-11 px-5 text-[0.9375rem]"
            >
              <Link to="/pricing">See plans</Link>
            </Button>
          </div>
        </div>
        <div className="min-w-0 lg:col-span-7">
          <pre className="overflow-x-auto border border-border bg-card p-5 font-mono text-[0.8125rem] leading-7 sm:p-6">
            <code>
              <span className="text-muted-foreground">
                # Kiln is in early development. To try it anyway, grab
                {"\n"}# compose.yaml and .env.hearth.example from
                github.com/kiln-site/kiln
              </span>
              {"\n"}
              <span className="text-primary">$</span> cp .env.hearth.example
              .env{"\n"}
              <span className="text-primary">$</span> docker compose up -d
            </code>
          </pre>
        </div>
      </div>
    </section>
  )
}
