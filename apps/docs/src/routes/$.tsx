import * as React from "react"
import { Link, createFileRoute, notFound } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, Check, Copy, PencilLine } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { Article } from "~/components/article"
import { DocsNav } from "~/components/docs-nav"
import { TableOfContents } from "~/components/table-of-contents"
import { markdownPath, withBase } from "~/lib/base"
import { links } from "~/lib/links"
import {
  loadPage,
  neighbours,
  sectionOf,
  type NavigationEntry,
} from "~/lib/pages"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/$")({
  loader: async ({ params }) => {
    const path = `/${(params._splat ?? "").replace(/\/+$/, "")}`
    const page = await loadPage(path)
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData, matches }) =>
    loaderData
      ? pageHead({
          description: loaderData.description,
          matches,
          path: loaderData.path,
          // The docs' home is the introduction, under the docs' own name.
          title:
            loaderData.path === "/"
              ? "Kiln Docs"
              : `${loaderData.title} | Kiln Docs`,
        })
      : {},
  component: DocsPage,
})

function DocsPage() {
  const page = Route.useLoaderData()
  const section = sectionOf(page.path)
  const { next, previous } = neighbours(page.path)

  return (
    <div className="mx-auto grid max-w-[90rem] grid-cols-1 gap-10 px-4 sm:px-6 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_13rem]">
      <aside className="hidden lg:block">
        <div className="sticky top-14 -ml-3 max-h-[calc(100dvh-3.5rem)] [scrollbar-width:thin] overflow-y-auto overscroll-contain py-8 pr-2">
          <DocsNav />
        </div>
      </aside>

      <article className="min-w-0 py-8 sm:py-10 lg:py-12">
        <div className="mx-auto max-w-3xl">
          <header className="border-b border-border/70 pb-6">
            {section ? (
              <p className="type-technical-label text-primary-ink">
                {section.title}
              </p>
            ) : null}
            <div className="mt-2 flex items-start justify-between gap-4">
              <h1 className="text-3xl font-semibold tracking-[-0.045em] text-balance sm:text-[2.5rem] sm:leading-[1.1]">
                {page.title}
              </h1>
              <CopyPageButton path={page.path} />
            </div>
            {page.description ? (
              <p className="mt-3 text-lg text-pretty text-muted-foreground">
                {page.description}
              </p>
            ) : null}
          </header>

          {page.headings.length > 0 ? (
            <details className="group mt-6 border border-border xl:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                On this page
                <span
                  aria-hidden="true"
                  className="text-muted-foreground transition-transform group-open:rotate-90"
                >
                  ›
                </span>
              </summary>
              <ul className="border-t border-border px-4 py-3 text-sm">
                {page.headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      className={cn(
                        "block py-1 text-muted-foreground hover:text-foreground",
                        heading.depth === 3 && "pl-4"
                      )}
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="mt-8">
            <Article key={page.path} html={page.html} />
          </div>

          <footer className="mt-14 border-t border-border/70 pt-6">
            <a
              href={`${links.contentSource}/${page.source}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <PencilLine className="size-4" />
              Edit this page on GitHub
            </a>
            <nav
              aria-label="Previous and next pages"
              className="mt-6 grid gap-3 sm:grid-cols-2"
            >
              {previous ? (
                <PagerLink page={previous} direction="previous" />
              ) : (
                <span />
              )}
              {next ? <PagerLink page={next} direction="next" /> : null}
            </nav>
          </footer>
        </div>
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto py-12">
          <TableOfContents key={page.path} headings={page.headings} />
        </div>
      </aside>
    </div>
  )
}

function PagerLink({
  direction,
  page,
}: {
  direction: "next" | "previous"
  page: NavigationEntry
}) {
  const next = direction === "next"
  return (
    <Link
      to="/$"
      params={{ _splat: page.path.replace(/^\//, "") }}
      className={cn(
        "group flex flex-col gap-1 border border-border p-4 transition-colors outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/60",
        next && "items-end text-right sm:col-start-2"
      )}
    >
      <span className="type-meta flex items-center gap-1.5 text-muted-foreground">
        {next ? null : <ArrowLeft className="size-3.5" />}
        {next ? "Next" : "Previous"}
        {next ? <ArrowRight className="size-3.5" /> : null}
      </span>
      <span className="font-medium text-foreground group-hover:text-primary-ink">
        {page.title}
      </span>
    </Link>
  )
}

// Copies the page's Markdown, to paste into an AI assistant or an issue.
function CopyPageButton({ path }: { path: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle")
  React.useEffect(() => {
    if (state === "idle") return
    const timer = window.setTimeout(() => setState("idle"), 1800)
    return () => window.clearTimeout(timer)
  }, [state])

  return (
    <button
      type="button"
      onClick={() => {
        const copy = async () => {
          const response = await fetch(withBase(markdownPath(path)))
          if (!response.ok) throw new Error(`Status ${response.status}`)
          await navigator.clipboard.writeText(await response.text())
        }
        void Promise.allSettled([copy()]).then(([result]) =>
          setState(result?.status === "fulfilled" ? "copied" : "failed")
        )
      }}
      className="mt-1.5 hidden h-8 shrink-0 items-center gap-1.5 border border-border px-2.5 text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:inline-flex"
    >
      {state === "copied" ? (
        <Check className="size-3.5 text-emerald-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Couldn’t copy"
          : "Copy page"}
    </button>
  )
}
