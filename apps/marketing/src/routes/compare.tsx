import type * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowUpRight, Gauge, Layers, LockOpen, Server } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { InstallCommand, useInstallCommand } from "~/components/install-command"
import {
  type Level,
  alternatives,
  checkedOn,
  products,
  rows,
} from "~/lib/comparison"
import { newTab } from "~/lib/new-tab"
import { pageHead } from "~/lib/seo"

export const Route = createFileRoute("/compare")({
  head: ({ matches }) =>
    pageHead({
      description:
        "How Kiln compares with Pterodactyl, AMP, Coolify, Dokploy, Openship, and Portainer, and when another tool fits better.",
      matches,
      path: "/compare",
      title: "Kiln compared with Pterodactyl, Coolify, and more | Kiln",
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
          Most panels pick a side: game servers, or apps, or containers. Kiln
          runs all three on your machines, from one modern panel built for
          speed. Here’s how it lines up, and when another tool fits better.
        </p>
      </section>

      <section className="site-container pb-20 sm:pb-28">
        <ComparisonTable />
        <p className="type-support mt-6 text-muted-foreground">
          Checked against each project’s own site and docs in {checkedOn}.
          Projects change quickly; if something here is out of date, email{" "}
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
      <WhyKiln />
      <TryKiln />
    </>
  )
}

function ComparisonTable() {
  return (
    <>
      {/* Wider than a phone, so it scrolls sideways with the labels pinned. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            Kiln compared with other panels, feature by feature
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
                    "relative border-b border-border px-2 pt-4 pb-3 text-center align-bottom font-semibold tracking-[-0.02em]",
                    product.id === "kiln"
                      ? "bg-card text-primary-ink"
                      : "text-foreground"
                  )}
                >
                  {product.id === "kiln" ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 top-0 h-0.5 bg-primary"
                    />
                  ) : null}
                  {product.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-border bg-background py-3.5 pr-3 text-left font-normal text-muted-foreground"
                >
                  {row.label}
                </th>
                {products.map((product) => (
                  <td
                    key={product.id}
                    className={cn(
                      "border-b border-border px-2 py-3.5",
                      product.id === "kiln" && "bg-card"
                    )}
                  >
                    <LevelMark level={row.cells[product.id]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="type-meta mt-4 flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground">
        {(["yes", "partly", "no"] as const).map((level) => (
          <li key={level} className="flex items-center gap-2">
            <LevelMark level={level} decorative />
            {levelLabels[level]}
          </li>
        ))}
      </ul>
    </>
  )
}

const levelLabels: Record<Level, string> = {
  yes: "Built in",
  partly: "Partly, or with extra work",
  no: "No",
}

// A filled, half-filled, or empty dot, so a row reads at a glance.
function LevelMark({
  decorative = false,
  level,
}: {
  decorative?: boolean
  level: Level
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
          level === "no" && "border border-muted-foreground/40"
        )}
      />
      {decorative ? null : (
        <span className="sr-only">{levelLabels[level]}</span>
      )}
    </span>
  )
}

function Alternatives() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <h2 className="site-title max-w-2xl">When another tool fits better</h2>
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

// What every card would otherwise repeat, said once.
const reasons: Array<{
  description: string
  icon: React.ReactNode
  title: string
}> = [
  {
    icon: <Gauge />,
    title: "Fast and modern",
    description:
      "Built for speed and a smooth experience, from the console to the file editor.",
  },
  {
    icon: <Layers />,
    title: "One panel for everything",
    description:
      "Game servers, apps, and databases, with the same console, files, backups, and access.",
  },
  {
    icon: <Server />,
    title: "Your machines",
    description:
      "Each instance runs on the machine you choose, even one behind NAT with no ports forwarded.",
  },
  {
    icon: <LockOpen />,
    title: "Free and open source",
    description:
      "AGPL-3.0, with no cap on instances or machines when you host it yourself.",
  },
]

function WhyKiln() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <h2 className="site-title max-w-2xl">For everything else, pick Kiln</h2>
        <ul className="mt-12 grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {reasons.map((reason) => (
            <li
              key={reason.title}
              className="flex flex-col gap-5 bg-background p-6"
            >
              <span className="grid size-10 place-items-center border border-primary/25 bg-primary/10 text-primary-ink [&_svg]:size-5">
                {reason.icon}
              </span>
              <div>
                <h3 className="font-semibold tracking-[-0.01em] text-foreground">
                  {reason.title}
                </h3>
                <p className="type-support mt-1.5 text-muted-foreground">
                  {reason.description}
                </p>
              </div>
            </li>
          ))}
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
