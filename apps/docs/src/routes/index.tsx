import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowRight, Search } from "lucide-react"

import { DiscordIcon, GitHubIcon } from "~/components/brand-icons"
import { CopyCommand } from "~/components/copy-command"
import { useOpenSearch } from "~/components/search"
import { links } from "~/lib/links"
import { sections } from "~/lib/pages"
import { pageHead } from "~/lib/seo"

const description =
  "Install Kiln and run game servers, apps, and databases on machines you own: guides, concepts, and reference."

export const Route = createFileRoute("/")({
  head: ({ matches }) =>
    pageHead({ description, matches, path: "/", title: "Kiln Docs" }),
  component: DocsHome,
})

function DocsHome() {
  const openSearch = useOpenSearch()
  const firstPage = sections[0]?.entries[0]

  return (
    <div className="mx-auto max-w-[90rem] px-4 sm:px-6">
      <section className="relative overflow-hidden border-b border-border/70 py-14 sm:py-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_70%_70%_at_20%_0%,black,transparent)] bg-[size:56px_56px] opacity-40"
        />
        <div className="relative max-w-3xl">
          <p className="type-technical-label text-primary-ink">Documentation</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-balance sm:text-6xl">
            Run everything on machines you own.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-pretty text-muted-foreground">
            Everything you need to install Kiln, connect your machines, and run
            game servers, apps, and databases from one panel.
          </p>
          <button
            type="button"
            onClick={openSearch}
            className="mt-8 flex h-12 w-full max-w-xl items-center gap-3 border border-border bg-card px-4 text-left text-muted-foreground transition-colors outline-none hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Search className="size-[18px] shrink-0" />
            <span className="flex-1">Search the docs</span>
            <kbd className="hidden h-6 items-center border border-border bg-muted/40 px-2 font-mono text-xs text-foreground sm:inline-flex">
              /
            </kbd>
          </button>
          <div className="mt-8 flex max-w-xl flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              On the machine that will run Kiln:
            </p>
            <CopyCommand command="curl -fsSL https://kiln.site/install | sh" />
          </div>
          {firstPage ? (
            <Link
              to="/$"
              params={{ _splat: firstPage.path.replace(/^\//, "") }}
              className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-primary-ink outline-none hover:underline focus-visible:underline"
            >
              New to Kiln? Start with the introduction
              <ArrowRight className="size-4" />
            </Link>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="sections" className="py-14 sm:py-16">
        <h2 id="sections" className="sr-only">
          Sections
        </h2>
        <ul className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => {
            const Icon = section.icon
            const first = section.entries[0]
            return (
              <li key={section.id} className="flex flex-col bg-background p-6">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 place-items-center border border-primary/25 bg-primary/10 text-primary-ink [&_svg]:size-[18px]">
                    <Icon />
                  </span>
                  <h3 className="font-semibold tracking-[-0.02em]">
                    {first ? (
                      <Link
                        to="/$"
                        params={{ _splat: first.path.replace(/^\//, "") }}
                        className="outline-none hover:text-primary-ink focus-visible:underline"
                      >
                        {section.title}
                      </Link>
                    ) : (
                      section.title
                    )}
                  </h3>
                </div>
                <p className="mt-3 text-sm text-pretty text-muted-foreground">
                  {section.summary}
                </p>
                <ul className="mt-4 flex flex-col gap-1.5 text-sm">
                  {section.entries.slice(0, 4).map((page) => (
                    <li key={page.path}>
                      <Link
                        to="/$"
                        params={{ _splat: page.path.replace(/^\//, "") }}
                        className="text-foreground/85 underline-offset-4 outline-none hover:text-primary-ink hover:underline focus-visible:underline"
                      >
                        {page.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="mb-16 flex flex-col gap-6 border border-border bg-card px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">
            Can’t find what you need?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask on Discord, or open an issue on GitHub.
          </p>
        </div>
        <div className="flex gap-3">
          <a
            href={links.discord}
            target="_blank"
            rel="noreferrer"
            className="flex h-10 items-center gap-2 border border-border px-4 text-sm transition-colors hover:border-foreground/25"
          >
            <DiscordIcon className="size-4" />
            Discord
          </a>
          <a
            href={`${links.github}/issues`}
            target="_blank"
            rel="noreferrer"
            className="flex h-10 items-center gap-2 border border-border px-4 text-sm transition-colors hover:border-foreground/25"
          >
            <GitHubIcon className="size-4" />
            GitHub issues
          </a>
        </div>
      </section>
    </div>
  )
}
