import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowUpRight } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card"
import { cn } from "@workspace/ui/lib/utils"

import { InstallCommand, useInstallCommand } from "~/components/install-command"
import {
  type Level,
  alternatives,
  bestAt,
  checkedOn,
  comparisonStructuredData,
  products,
  rows,
} from "~/lib/comparison"
import { newTab } from "~/lib/new-tab"
import { pageHead, siteUrlOf } from "~/lib/seo"

const title = "Kiln vs Pterodactyl, Coolify, Dokploy, and more"
const description =
  "Compare Kiln with Pterodactyl, AMP, Coolify, Dokploy, Openship, and Portainer: game servers, apps, databases, permissions, and backups, and when each fits best."

export const Route = createFileRoute("/compare")({
  head: ({ matches }) => ({
    ...pageHead({ description, matches, path: "/compare", title }),
    scripts: [
      {
        type: "application/ld+json",
        children: comparisonStructuredData({
          description,
          siteUrl: siteUrlOf(matches),
          title,
        }),
      },
    ],
  }),
  component: ComparePage,
})

const productsById = new Map(products.map((product) => [product.id, product]))

function ComparePage() {
  return (
    <>
      <section className="site-container pt-10 pb-10 sm:pt-14">
        <h1 className="site-title max-w-3xl">
          Game server panel or app platform? Kiln is both.
        </h1>
        <p className="site-copy mt-3 max-w-2xl text-muted-foreground">
          Most panels do game servers or apps.
          <br />
          Kiln does both, on your own machines, from one fast panel.
        </p>
      </section>

      <section
        aria-labelledby="features-heading"
        className="site-container pb-20 sm:pb-28"
      >
        <h2 id="features-heading" className="sr-only">
          Feature comparison
        </h2>
        <ComparisonTable />
        <p className="type-support mt-6 text-muted-foreground">
          Checked against each project’s own site and docs in{" "}
          <time dateTime={checkedOn.iso}>{checkedOn.label}</time>. Projects
          change quickly; if something here is out of date, email{" "}
          <a
            href="mailto:contact@kiln.site"
            className="text-foreground underline underline-offset-4 hover:text-primary-ink"
          >
            contact@kiln.site
          </a>
          .
        </p>
      </section>

      <Alternatives />
      <TryKiln />
    </>
  )
}

// Opaque, so the pinned Kiln column covers what scrolls beneath it.
const bestClassName =
  "bg-[color-mix(in_oklab,var(--primary)_10%,var(--background))]"

// On a phone the labels and Kiln stay put while the others scroll past.
const pinnedKilnClassName =
  "sticky left-36 z-10 sm:left-48 max-sm:shadow-[1px_0_0_var(--border)]"

function ComparisonTable() {
  return (
    <>
      {/* Wider than a phone, so it scrolls sideways with the labels and Kiln pinned. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Features of Kiln, Pterodactyl, AMP, Coolify, Dokploy, Openship, and
            Portainer
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 w-36 border-b border-border bg-background sm:w-48"
              >
                <span className="sr-only">Feature</span>
              </th>
              {products.map((product) => (
                <th
                  key={product.id}
                  scope="col"
                  className={cn(
                    "border-b border-border bg-background px-2 pt-4 pb-3 text-center align-bottom font-semibold tracking-[-0.02em]",
                    product.id === "kiln"
                      ? cn("text-primary-ink", pinnedKilnClassName)
                      : "text-foreground"
                  )}
                >
                  {product.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const best = bestAt(row)
              return (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-border bg-background py-3.5 pr-3 text-left font-normal text-muted-foreground"
                  >
                    {row.label}
                  </th>
                  {products.map((product) => {
                    const isBest = best.includes(product.id)
                    return (
                      <td
                        key={product.id}
                        className={cn(
                          "border-b border-border bg-background px-2 py-3.5",
                          isBest && bestClassName,
                          product.id === "kiln" && pinnedKilnClassName
                        )}
                      >
                        <CellMark
                          best={isBest}
                          level={row.cells[product.id]}
                          note={row.notes?.[product.id]}
                        />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="type-meta mt-4 flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
        {(["yes", "partly", "weak", "no"] as const).map((level) => (
          <li key={level} className="flex items-center gap-2">
            <LevelMark level={level} decorative />
            {levelLabels[level]}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn("size-3 ring-1 ring-primary/30", bestClassName)}
          />
          Best at it
        </li>
        <li>Hover or tap partial support to see why.</li>
      </ul>
    </>
  )
}

const levelLabels: Record<Level, string> = {
  yes: "Built in",
  partly: "Partly, or with extra work",
  weak: "Barely",
  no: "No",
}

// A cell's dot. A partial one explains itself on hover, or on tap on a
// phone, where hovering isn't possible.
function CellMark({
  best,
  level,
  note,
}: {
  best: boolean
  level: Level
  note: string | undefined
}) {
  const [open, setOpen] = React.useState(false)
  if (!note) return <LevelMark best={best} level={level} />
  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={100}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="mx-auto -my-1 flex cursor-help p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => setOpen(true)}
        >
          <LevelMark best={best} level={level} note={note} />
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="type-support w-60 text-left">
        <span className="type-label block text-muted-foreground">
          {levelLabels[level]}
        </span>
        <span className="mt-1 block text-foreground">{note}</span>
      </HoverCardContent>
    </HoverCard>
  )
}

// A filled, half, quarter, or empty dot, so a row reads at a glance.
function LevelMark({
  best = false,
  decorative = false,
  level,
  note,
}: {
  best?: boolean
  decorative?: boolean
  level: Level
  note?: string
}) {
  return (
    <span className="flex justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "size-3 rounded-full",
          level === "yes" && "bg-primary",
          level === "partly" &&
            "border border-primary bg-[linear-gradient(90deg,var(--primary)_50%,transparent_50%)]",
          level === "weak" &&
            "border border-primary bg-[conic-gradient(from_270deg,var(--primary)_0_25%,transparent_0)]",
          level === "no" && "border border-muted-foreground/40"
        )}
      />
      {decorative ? null : (
        <span className="sr-only">
          {[levelLabels[level], best && "best at it"]
            .filter(Boolean)
            .join(", ")}
          {note ? `. ${note}` : null}
        </span>
      )}
    </span>
  )
}

function Alternatives() {
  return (
    <section
      id="alternatives"
      aria-labelledby="alternatives-heading"
      className="border-t border-border"
    >
      <div className="site-container py-20 sm:py-28">
        <h2 id="alternatives-heading" className="site-title max-w-2xl">
          When another tool fits better
        </h2>
        <ul className="mt-12 grid gap-px border border-border bg-border md:grid-cols-2">
          {alternatives.map((alternative) => {
            const product = productsById.get(alternative.id)
            if (!product) return null
            return (
              <li
                key={alternative.id}
                id={alternative.id}
                className="flex scroll-mt-20 flex-col bg-background p-6 sm:p-7"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-xl font-semibold tracking-[-0.03em]">
                    {product.name}
                  </h3>
                  {product.url ? (
                    <a
                      href={product.url}
                      {...newTab}
                      className="type-support flex shrink-0 items-center gap-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
                    >
                      Website
                      <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </a>
                  ) : null}
                </div>
                <p className="type-support mt-2 text-muted-foreground">
                  {alternative.summary}
                </p>
                <p className="type-support mt-5 border-t border-border pt-5">
                  <span className="type-label block text-muted-foreground">
                    Pick {product.name} if
                  </span>
                  <span className="mt-1 block text-foreground">
                    {alternative.pickThem}
                  </span>
                </p>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function TryKiln() {
  const command = useInstallCommand()
  return (
    <section className="border-t border-border">
      <div className="site-container grid gap-10 py-20 sm:py-28 lg:grid-cols-12 lg:items-center lg:gap-16">
        <div className="lg:col-span-5">
          <h2 className="site-title">Try it on your own machine</h2>
          <p className="site-lede mt-4 text-muted-foreground">
            It needs only Docker. Kiln is in early development.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
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
          <InstallCommand
            command={command}
            className="border border-border bg-card py-1.5 pr-1.5 pl-4"
          />
        </div>
      </div>
    </section>
  )
}
