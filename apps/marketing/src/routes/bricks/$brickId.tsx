import * as React from "react"
import { Link, createFileRoute, notFound } from "@tanstack/react-router"
import { ArrowLeft, Download, ExternalLink, PencilRuler } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { BrickCard } from "~/components/bricks/brick-card"
import { BrickTile } from "~/components/bricks/brick-glyph"
import { CopyButton, downloadText } from "~/components/bricks/copy-button"
import { InstallPreview } from "~/components/bricks/install-preview"
import { JsonView } from "~/components/bricks/json-view"
import { BrickKindIcon } from "~/components/bricks/kind-icon"
import {
  brickDeployLabels,
  brickKindLabels,
  brickKindPluralLabels,
  findListedBrick,
  formatBrickJson,
  listedBricks,
  sourceBrickUrl,
} from "~/lib/bricks"
import { newTab } from "~/lib/new-tab"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/bricks/$brickId")({
  loader: ({ params }) => {
    const listed = findListedBrick(params.brickId)
    if (!listed) throw notFound()
    return { id: listed.brick.id }
  },
  head: ({ loaderData, matches }) => {
    const listed = loaderData ? findListedBrick(loaderData.id) : undefined
    return pageHead({
      description: listed?.brick.summary,
      matches,
      path: `/bricks/${loaderData?.id ?? ""}`,
      title: listed ? `${listed.brick.name} Brick | Kiln` : "Brick | Kiln",
    })
  },
  component: BrickPage,
})

const linkLabels = {
  homepage: "Website",
  docs: "Docs",
  source: "Source",
  support: "Support",
} as const

function BrickPage() {
  const { id } = Route.useLoaderData()
  const listed = findListedBrick(id)!
  const { brick } = listed
  const json = React.useMemo(() => formatBrickJson(brick), [brick])
  const related = listedBricks
    .filter(
      (other) => other.brick.kind === brick.kind && other.brick.id !== brick.id
    )
    .slice(0, 3)

  return (
    <>
      <section className="border-b border-border">
        <div className="site-container pt-8 pb-10 sm:pt-10">
          <Link
            to="/bricks"
            className="type-control inline-flex items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ArrowLeft className="size-4" />
            Bricks
          </Link>
          <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 items-start gap-5">
              <BrickTile
                color={brick.color}
                iconUrl={listed.iconUrl}
                id={brick.id}
                size="lg"
              />
              <div className="min-w-0">
                <h1 className="site-title">{brick.name}</h1>
                <p className="site-copy mt-1.5 max-w-2xl text-muted-foreground">
                  {brick.summary}
                </p>
                <p className="type-support mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <BrickKindIcon kind={brick.kind} className="size-4" />
                    {brickKindLabels[brick.kind]}
                  </span>
                  <span>{brickDeployLabels[brick.deploy.type]}</span>
                  <span>by {brick.author}</span>
                  <span
                    className={
                      listed.tier === "official"
                        ? "type-label text-primary-ink"
                        : "type-label"
                    }
                  >
                    {listed.tier === "official" ? "Official" : "Community"}
                  </span>
                  {Object.entries(brick.links ?? {}).map(([key, href]) => (
                    <a
                      key={key}
                      href={href}
                      {...newTab}
                      className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {linkLabels[key as keyof typeof linkLabels]}
                      <ExternalLink className="size-3" />
                    </a>
                  ))}
                </p>
                {brick.tags?.length ? (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {brick.tags.map((tag) => (
                      <li
                        key={tag}
                        className="type-label border border-border px-1.5 py-0.5 text-muted-foreground"
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button asChild>
                <Link to="/bricks/new" search={{ from: brick.id }}>
                  <PencilRuler />
                  Open in creator
                </Link>
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadText(`${brick.id}.json`, json)}
              >
                <Download />
                Download
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="site-container py-12">
        <h2 className="type-page-title">Installing it</h2>
        <p className="type-support mt-1 mb-5 text-muted-foreground">
          Change the answers to see what Kiln would run with them.
        </p>
        <InstallPreview key={brick.id} brick={brick} iconUrl={listed.iconUrl} />
      </section>

      <section className="site-container pb-16">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="type-page-title">The Brick</h2>
            <p className="type-support mt-1 text-muted-foreground">
              <code className="type-code">{listed.path}</code>,{" "}
              {json.split("\n").length - 1} lines
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy JSON" text={json} toast="Brick copied" />
            <Button asChild variant="ghost" size="sm">
              <a href={sourceBrickUrl(listed)} {...newTab}>
                View on GitHub
                <ExternalLink />
              </a>
            </Button>
          </div>
        </div>
        <JsonView
          text={json}
          className="type-code max-h-[36rem] overflow-auto border border-border bg-card/50 p-5 text-muted-foreground"
        />
      </section>

      {related.length > 0 ? (
        <section className="site-container pb-20">
          <h2 className="type-page-title mb-5">
            More {brickKindPluralLabels[brick.kind].toLowerCase()}
          </h2>
          <ul className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {related.map((other) => (
              <BrickCard key={other.brick.id} listed={other} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
