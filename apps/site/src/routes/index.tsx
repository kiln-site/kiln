import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import {
  AppKindIcon,
  DatabaseKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { CyclingWord } from "~/components/cycling-word"
import { ComingSoon } from "~/components/coming-soon"
import { ClientDemo } from "~/components/demos/client-demo"
import { signUpUrl } from "~/lib/plans"
import { comingSoon } from "~/lib/coming-soon"
import { newTab } from "~/lib/new-tab"
import { useSiteConfig } from "~/lib/use-site-config"

const HearthDemo = React.lazy(() => import("~/components/demos/hearth-demo"))
const OverviewDemo = React.lazy(
  () => import("~/components/demos/overview-demo")
)

export const Route = createFileRoute("/")({
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

const heroWords = ["game servers", "apps", "Docker", "databases", "everything"]

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
          <h1 className="site-display lg:col-span-8">
            <span className="sr-only">
              The panel for game servers, apps, Docker, databases, and more
            </span>
            <span aria-hidden="true">The panel for</span>
            <span className="text-primary">
              <CyclingWord words={heroWords} />
            </span>
          </h1>
          <div className="lg:col-span-4 lg:pb-2">
            <p className="site-lede max-w-md text-muted-foreground">
              Put a Relay on each machine you own, then start, watch, edit, and
              back up everything on them from your browser.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <ComingSoon soon={comingSoon.signUp} label="Get started">
                <Button asChild className="h-11 px-5 text-[0.9375rem]">
                  <a href={signUpUrl(hearthUrl)}>Get started</a>
                </Button>
              </ComingSoon>
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
          <figcaption className="type-support mt-3 max-w-xl text-muted-foreground">
            This is Hearth, running in your browser on a simulated server.
            Search its 100,000 lines of output, send{" "}
            <code className="type-code text-foreground">list</code>, or restart
            it.
          </figcaption>
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
        <SectionHeading title="Game servers, apps, and databases, side by side">
          Each runs in its own container on a machine you choose, and each gets
          the same console, files, backups, and access controls.
        </SectionHeading>

        <div className="mt-14 grid gap-px border border-border bg-border md:grid-cols-3">
          <Kind
            icon={<ServerKindIcon className="size-5" />}
            title="Game servers"
            description="Pick a Brick and Kiln sets up the server, its ports, and the right Java for you."
          >
            <ul className="flex flex-wrap gap-2" aria-label="Official Bricks">
              {officialBricks.map((brick) => (
                <li
                  key={brick.name}
                  className="type-label flex items-center gap-1.5 border border-border px-2 py-1 text-foreground"
                >
                  <BrickMark icon={brick.icon} />
                  {brick.name}
                </li>
              ))}
            </ul>
          </Kind>
          <Kind
            icon={<AppKindIcon className="size-5" />}
            title="Apps"
            description="Deploy from a GitHub repository with a Dockerfile or Compose file. Pushes roll out as rolling deployments, on your own domains."
          >
            <KindFacts facts={["Dockerfile", "Compose", "Custom domains"]} />
          </Kind>
          <Kind
            icon={<DatabaseKindIcon className="size-5" />}
            title="Databases"
            description="Start a database next to the app or server that needs it, and browse its tables from Hearth."
          >
            <KindFacts
              facts={["MySQL", "MariaDB", "PostgreSQL", "Redis", "Valkey"]}
            />
          </Kind>
        </div>
      </div>
    </section>
  )
}

function Kind({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 bg-background p-6 sm:p-8">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="text-lg font-semibold tracking-[-0.02em]">{title}</h3>
      </div>
      <p className="site-copy text-muted-foreground">{description}</p>
      <div className="mt-auto pt-2">{children}</div>
    </div>
  )
}

function KindFacts({ facts }: { facts: Array<string> }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {facts.map((fact) => (
        <li
          key={fact}
          className="type-label border border-border px-2 py-1 text-foreground"
        >
          {fact}
        </li>
      ))}
    </ul>
  )
}

function Editor() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <SectionHeading title="Edit config files where they live">
              Open any file on any server and change it in the browser. This is
              Hearth’s file editor, so try it.
            </SectionHeading>
          </div>
          <ul className="site-copy grid gap-6 text-muted-foreground sm:grid-cols-3 lg:col-span-7 lg:pt-2">
            <EditorPoint title="Changes stay marked">
              Edited lines are flagged against the saved file until you save or
              discard them.
            </EditorPoint>
            <EditorPoint title="Addresses stay hidden">
              IP addresses are masked on screen, like{" "}
              <code className="type-code text-foreground">server-ip</code>, so a
              screenshot or a stream doesn’t give them away.
            </EditorPoint>
            <EditorPoint title="NBT opens as text">
              Binary files like{" "}
              <code className="type-code text-foreground">level.dat</code> open
              as SNBT and are checked as you type.
            </EditorPoint>
          </ul>
        </div>
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

function EditorPoint({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="border-l-2 border-primary/70 pl-4">
      <span className="font-medium text-foreground">{title}.</span> {children}
    </li>
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

const features = [
  {
    title: "Backups",
    description:
      "Scheduled backups to S3-compatible storage, restored in place.",
  },
  {
    title: "Schedules",
    description: "Restart, back up, or run a command on a timetable.",
  },
  {
    title: "Access",
    description: "Invite people and choose what they can do on each instance.",
  },
  {
    title: "Activity",
    description: "A record of who changed what, and when.",
  },
  {
    title: "Command line",
    description: "Script power, files, and backups with the kiln CLI.",
  },
  {
    title: "Tailscale",
    description: "Reach instances privately over your tailnet.",
  },
  {
    title: "Domains",
    description: "Point your own domains at apps, with HTTPS.",
  },
  {
    title: "Updates",
    description: "Update Hearth and every Relay from the panel.",
  },
]

function Features() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <SectionHeading title="And the rest of running a server" />
        <dl className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div key={feature.title} className="border-t border-border pt-4">
              <dt className="font-medium">{feature.title}</dt>
              <dd className="type-support mt-1.5 text-muted-foreground">
                {feature.description}
              </dd>
            </div>
          ))}
        </dl>
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
            Kiln is open source under AGPL-3.0. Run Hearth and your Relays
            yourself with Docker Compose, or let us host Hearth while your
            machines stay yours.
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
                # compose.yaml and .env.hearth.example from
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
