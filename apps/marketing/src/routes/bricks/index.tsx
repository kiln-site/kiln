import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowRight, BookOpen, Braces, Plus, Search, Users } from "lucide-react"

import type { BrickV2Kind } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

import { BrickCard } from "~/components/bricks/brick-card"
import { CopyButton } from "~/components/bricks/copy-button"
import { JsonView } from "~/components/bricks/json-view"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  brickKindPluralLabels,
  bricksFolderUrl,
  communityBricks,
  communityFolderUrl,
  listedBricks,
  officialBricks,
  officialCatalog,
  officialCatalogUrl,
} from "~/lib/bricks"
import { newTab } from "~/lib/new-tab"
import { pageHead } from "~/lib/seo"

type KindFilter = BrickV2Kind | "all"

const kindFilters: ReadonlyArray<KindFilter> = [
  "all",
  "game-server",
  "app",
  "database",
]

function isKind(value: unknown): value is BrickV2Kind {
  return value === "game-server" || value === "app" || value === "database"
}

export const Route = createFileRoute("/bricks/")({
  // Every Brick is the default, so only a kind shows in the URL.
  validateSearch: (search: Record<string, unknown>): { kind?: BrickV2Kind } =>
    isKind(search.kind) ? { kind: search.kind } : {},
  head: ({ matches }) =>
    pageHead({
      description:
        "Bricks tell Kiln how to run game servers, apps, and databases. Browse the official catalog, find community Bricks, or build your own.",
      matches,
      path: "/bricks",
      title: "Bricks | Kiln",
    }),
  component: BricksPage,
})

function BricksPage() {
  return (
    <>
      <Hero />
      <Catalog />
      <Anatomy />
      <Community />
      <Catalogs />
    </>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_20%_0%,black,transparent)] bg-[size:48px_48px]"
      />
      <div className="site-container relative grid gap-10 pt-12 pb-14 sm:pt-20 sm:pb-20 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-7">
          <p className="type-technical-label text-primary-ink">Bricks</p>
          <h1 className="site-display mt-4">
            Everything Kiln runs starts as a Brick.
          </h1>
          <p className="site-lede mt-6 max-w-xl text-muted-foreground">
            One small JSON file says what to ask for, what to run, and how to
            reach it. Start from ours, pick up the community&rsquo;s, or build
            your own in the browser.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild className="h-11 px-5 text-[0.9375rem]">
              <Link to="/bricks/new">
                <Plus />
                Create a Brick
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="h-11 px-5 text-[0.9375rem]"
            >
              <Link to="/bricks" hash="catalog" resetScroll={false}>
                Browse the catalog
              </Link>
            </Button>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-px border border-border bg-border lg:col-span-5">
          <Stat label="Official" value={officialBricks.length} />
          <Stat label="Community" value={communityBricks.length} />
          <Stat label="Format" value="v2" />
        </dl>
      </div>
      <p className="site-container type-meta relative pb-6 text-muted-foreground">
        Format v2 is in preview: Hearth runs v1 Bricks today, and these pages
        show where Bricks are headed.
      </p>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 bg-background px-5 py-4">
      <dt className="type-label text-muted-foreground">{label}</dt>
      <dd className="font-heading text-3xl font-semibold tracking-[-0.04em] tabular-nums">
        {value}
      </dd>
    </div>
  )
}

function Catalog() {
  const { kind } = Route.useSearch()
  const filter: KindFilter = kind ?? "all"
  const [query, setQuery] = React.useState("")
  const deferredQuery = React.useDeferredValue(query)
  const shown = React.useMemo(() => {
    const words = deferredQuery
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
    return listedBricks.filter(({ brick }) => {
      if (filter !== "all" && brick.kind !== filter) return false
      if (words.length === 0) return true
      const text = [
        brick.name,
        brick.id,
        brick.summary,
        brick.author,
        brick.game?.title,
        ...(brick.tags ?? []),
      ]
        .join(" ")
        .toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [deferredQuery, filter])

  return (
    <section id="catalog" className="site-container py-16 sm:py-20">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="site-title">Catalog</h2>
          <p className="site-copy mt-2 max-w-xl text-muted-foreground">
            Game servers, databases, and every way to deploy an app, each one a
            Brick you can open, read, and copy.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <KindSwitch filter={filter} />
          <label className="relative block sm:w-56">
            <span className="sr-only">Search Bricks</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="h-9 pl-8"
            />
          </label>
        </div>
      </div>

      {shown.length > 0 ? (
        <ul className="mt-8 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((listed) => (
            <BrickCard key={listed.brick.id} listed={listed} />
          ))}
        </ul>
      ) : (
        <div className="mt-8 border border-dashed border-border px-6 py-14 text-center">
          <p className="type-section-title">No Bricks match</p>
          <p className="type-support mt-1 text-muted-foreground">
            Try another word, or{" "}
            <Link
              to="/bricks/new"
              className="text-foreground underline underline-offset-4 hover:text-primary-ink"
            >
              build the Brick you&rsquo;re after
            </Link>
            .
          </p>
        </div>
      )}
    </section>
  )
}

function KindSwitch({ filter }: { filter: KindFilter }) {
  const navigate = Route.useNavigate()
  return (
    <div
      role="group"
      aria-label="Kind"
      className="inline-flex shrink-0 self-start border border-border bg-card p-0.5 sm:self-auto"
    >
      {kindFilters.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={filter === option}
          className="flex h-8 items-center gap-1.5 px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-accent aria-pressed:text-foreground"
          onClick={() =>
            void navigate({
              search: option === "all" ? {} : { kind: option },
              replace: true,
              resetScroll: false,
            })
          }
        >
          {option === "all" ? null : (
            <BrickKindIcon kind={option} className="size-3.5" />
          )}
          {option === "all" ? "All" : brickKindPluralLabels[option]}
        </button>
      ))}
    </div>
  )
}

const anatomy = [
  {
    title: "Who it is",
    body: "An id, a name, and a kind: game server, app, or database. The kind decides where it shows up in Hearth.",
    code: {
      format: "kiln.brick/v2",
      id: "paper",
      name: "Paper",
      kind: "game-server",
      summary: "Fast, plugin-compatible Minecraft server.",
    },
  },
  {
    title: "What it asks for",
    body: "Inputs become the install form: text, numbers, toggles, choices, and secrets Kiln can generate. A default can follow another answer.",
    code: {
      inputs: [
        {
          key: "java_version",
          type: "select",
          options: ["17", "21", "25"],
          suggest: [{ when: "version", matches: "^26\\.", value: "25" }],
        },
      ],
    },
  },
  {
    title: "How it runs",
    body: "A Docker image, a Dockerfile, a Compose project, or a static site. Templates fill answers in where they go.",
    code: {
      deploy: {
        type: "image",
        image: "ghcr.io/kiln-site/bricks-java:{{ java_version }}",
        ports: [{ name: "game", port: 25565 }],
        volumes: [{ path: "/server" }],
      },
    },
  },
  {
    title: "What its kind needs",
    body: "Game servers say how players connect and stop. Databases say how to connect, back up, and restore.",
    code: {
      database: {
        engine: "postgres",
        port: "postgres",
        connection: "postgres://{{ username }}@{{ kiln.host }}",
        backup: { command: "pg_dump …", extension: "sql" },
      },
    },
  },
] as const

function Anatomy() {
  return (
    <section
      id="format"
      className="border-y border-border bg-card/30 py-16 sm:py-20"
    >
      <div className="site-container">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="site-title">One file, four parts</h2>
            <p className="site-copy mt-2 max-w-xl text-muted-foreground">
              Only what Kiln can&rsquo;t work out for itself goes in a Brick.
              Everything else, like memory limits and domains, stays a setting
              in Hearth.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href={`${bricksFolderUrl}/docs/brick-v2.md`} {...newTab}>
                <BookOpen />
                Read the format
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="/bricks/schema.json" {...newTab}>
                <Braces />
                JSON Schema
              </a>
            </Button>
          </div>
        </div>
        <ol className="mt-8 grid gap-px border border-border bg-border md:grid-cols-2 xl:grid-cols-4">
          {anatomy.map((part, index) => (
            <li key={part.title} className="flex flex-col bg-background">
              <div className="p-5">
                <p className="type-technical-label text-primary-ink">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="type-section-title mt-2">{part.title}</h3>
                <p className="type-support mt-1.5 text-muted-foreground">
                  {part.body}
                </p>
              </div>
              <JsonView
                text={JSON.stringify(part.code, null, 2)}
                className="type-code mt-auto overflow-x-auto border-t border-border bg-card/50 p-4 text-[0.75rem] text-muted-foreground"
              />
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Community() {
  return (
    <section id="community" className="site-container py-16 sm:py-20">
      <div className="flex flex-col gap-2">
        <h2 className="site-title">Community</h2>
        <p className="site-copy max-w-xl text-muted-foreground">
          Bricks made by Kiln users and reviewed by its maintainers before
          they&rsquo;re listed.
        </p>
      </div>
      {communityBricks.length > 0 ? (
        <ul className="mt-8 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {communityBricks.map((listed) => (
            <BrickCard key={listed.brick.id} listed={listed} />
          ))}
        </ul>
      ) : (
        <div className="mt-8 grid gap-px border border-border bg-border md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex flex-col justify-center gap-3 bg-background p-8">
            <Users className="size-6 text-primary-ink" />
            <p className="font-heading text-2xl font-semibold tracking-[-0.035em]">
              No community Bricks yet.
            </p>
            <p className="type-support text-muted-foreground">
              The first one listed here could be yours.
            </p>
          </div>
          <ol className="flex flex-col divide-y divide-border bg-background">
            {[
              [
                "Build it",
                "Fill in the creator and try the install form it makes.",
              ],
              [
                "Open a pull request",
                "Download the JSON and add it under apps/bricks/community.",
              ],
              [
                "Get it reviewed",
                "A maintainer checks what it runs. Merged means listed.",
              ],
            ].map(([title, body], index) => (
              <li key={title} className="flex gap-4 px-6 py-5">
                <span className="type-technical-label pt-0.5 text-primary-ink">
                  {index + 1}
                </span>
                <span>
                  <span className="type-section-title block">{title}</span>
                  <span className="type-support text-muted-foreground">
                    {body}
                  </span>
                </span>
              </li>
            ))}
            <li className="flex flex-wrap gap-2 px-6 py-5">
              <Button asChild>
                <Link to="/bricks/new">
                  <Plus />
                  Create a Brick
                </Link>
              </Button>
              <Button asChild variant="ghost">
                <a href={communityFolderUrl} {...newTab}>
                  How reviews work
                  <ArrowRight />
                </a>
              </Button>
            </li>
          </ol>
        </div>
      )}
    </section>
  )
}

function Catalogs() {
  return (
    <section
      id="catalogs"
      className="border-t border-border bg-card/30 py-16 sm:py-20"
    >
      <div className="site-container">
        <h2 className="site-title">Catalogs</h2>
        <p className="site-copy mt-2 max-w-xl text-muted-foreground">
          A catalog is a list of Bricks at a URL. Hearth reads the official one
          out of the box, and you can add your own for Bricks you keep private.
        </p>
        <ul className="mt-8 grid gap-px border border-border bg-border lg:grid-cols-2">
          <li className="flex flex-col gap-4 bg-background p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="type-section-title">
                {officialCatalog.name} official
              </h3>
              <span className="type-label text-primary-ink">
                {officialBricks.length} Bricks
              </span>
            </div>
            <p className="type-support text-muted-foreground">
              {officialCatalog.summary}
            </p>
            <code className="type-code block truncate border border-border bg-card/60 px-3 py-2 text-muted-foreground">
              {officialCatalogUrl}
            </code>
            <div className="flex flex-wrap gap-2">
              <CopyButton
                label="Copy URL"
                text={officialCatalogUrl}
                toast="Catalog URL copied"
              />
              <Button asChild variant="ghost" size="sm">
                <a href={bricksFolderUrl} {...newTab}>
                  View on GitHub
                  <ArrowRight />
                </a>
              </Button>
            </div>
          </li>
          <li className="flex flex-col gap-4 bg-background p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="type-section-title">Your own</h3>
              <span className="type-label text-muted-foreground">
                Any HTTPS URL
              </span>
            </div>
            <p className="type-support text-muted-foreground">
              List your Bricks by path or link, host the file anywhere, and add
              its URL in Hearth&rsquo;s Bricks settings.
            </p>
            <JsonView
              text={JSON.stringify(
                {
                  format: "kiln.catalog/v2",
                  name: "My Bricks",
                  author: "you",
                  bricks: ["bricks/my-game.json"],
                },
                null,
                2
              )}
              className={cn(
                "type-code overflow-x-auto border border-border bg-card/60 px-3 py-2 text-[0.75rem] text-muted-foreground"
              )}
            />
          </li>
        </ul>
      </div>
    </section>
  )
}
