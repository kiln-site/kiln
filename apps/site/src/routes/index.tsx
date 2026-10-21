import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

import { BrickMark, officialBricks } from "~/components/brick-mark"
import { CyclingWord } from "~/components/cycling-word"
import { ClientDemo } from "~/components/demos/client-demo"
import { signUpUrl } from "~/lib/plans"
import { useSiteConfig } from "~/lib/use-site-config"

const HearthDemo = React.lazy(() => import("~/components/demos/hearth-demo"))

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  return (
    <>
      <Hero />
      <Kinds />
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
              <Button asChild className="h-11 px-5 text-[0.9375rem]">
                <a href={signUpUrl(hearthUrl)}>Get started</a>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-11 px-5 text-[0.9375rem]"
              >
                <a href={docsUrl}>Read the docs</a>
              </Button>
            </div>
          </div>
        </div>

        <figure className="mt-12 sm:mt-16">
          <div className="h-[40rem] sm:h-[44rem] lg:h-[50rem]">
            <ClientDemo fallback={<DemoFrame label="Opening Hearth…" />}>
              <HearthDemo />
            </ClientDemo>
          </div>
          <figcaption className="type-support mt-3 max-w-xl text-muted-foreground">
            This is Hearth, running in your browser on a simulated server.
            Search its 100,000 lines of output, send{" "}
            <code className="type-code text-foreground">list</code>, restart it,
            or open its files.
          </figcaption>
        </figure>
      </div>
    </section>
  )
}

function DemoFrame({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center border border-border bg-card">
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

const relays = [
  {
    name: "home-lab",
    place: "The PC under the desk",
    instances: [
      { kind: "server", name: "survival-smp" },
      { kind: "server", name: "creative" },
      { kind: "database", name: "luckperms-db" },
    ],
  },
  {
    name: "fsn1-dedicated",
    place: "A rented server in Falkenstein",
    instances: [
      { kind: "server", name: "velocity-proxy" },
      { kind: "app", name: "community-site" },
      { kind: "database", name: "postgres" },
    ],
  },
  {
    name: "garage-nuc",
    place: "A spare mini PC",
    instances: [
      { kind: "server", name: "palworld" },
      { kind: "app", name: "discord-bot" },
    ],
  },
] as const

const kindIcons = {
  app: AppKindIcon,
  database: DatabaseKindIcon,
  server: ServerKindIcon,
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

        <div className="mt-14">
          <div className="flex items-center gap-3 border border-primary/45 bg-card px-5 py-4 md:mx-auto md:w-fit">
            <span className="text-sm font-semibold">Hearth</span>
            <span className="type-meta text-muted-foreground">
              Your panel, in the browser
            </span>
          </div>
          <ol className="relative mt-6 grid gap-4 border-l border-border pl-5 md:mt-0 md:grid-cols-3 md:gap-6 md:border-l-0 md:pt-10 md:pl-0">
            <span
              aria-hidden="true"
              className="absolute top-0 left-1/2 hidden h-5 w-px bg-border md:block"
            />
            <span
              aria-hidden="true"
              className="absolute top-5 right-[calc((100%-3rem)/6)] left-[calc((100%-3rem)/6)] hidden h-px bg-border md:block"
            />
            {relays.map((relay) => (
              <li key={relay.name} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -top-5 left-1/2 hidden h-5 w-px bg-border md:block"
                />
                <div className="border border-border bg-card">
                  <div className="flex items-center gap-2.5 border-b px-4 py-3">
                    <RelayKindIcon className="size-4" />
                    <span className="text-sm font-medium">{relay.name}</span>
                    <span
                      aria-label="Connected"
                      className="ml-auto size-1.5 bg-emerald-400"
                    />
                  </div>
                  <p className="type-meta px-4 pt-3 text-muted-foreground">
                    {relay.place}
                  </p>
                  <ul className="space-y-2 px-4 pt-3 pb-4">
                    {relay.instances.map((instance) => {
                      const Icon = kindIcons[instance.kind]
                      return (
                        <li
                          key={instance.name}
                          className="type-code flex items-center gap-2 text-foreground"
                        >
                          <Icon className="size-3.5" />
                          {instance.name}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
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
            <Button asChild className="h-11 px-5 text-[0.9375rem]">
              <a href={docsUrl}>Install Kiln</a>
            </Button>
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
