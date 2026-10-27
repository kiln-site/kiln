import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowUpRight, Check, Minus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { InstallCommand, useInstallCommand } from "~/components/install-command"
import {
  type Cell,
  type Product,
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
        "How Kiln compares with Pterodactyl, AMP, Coolify, Dokploy, Openship, and Portainer, and when to pick each one.",
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
          runs all three on your machines, from one panel. Here’s how it lines
          up, and when another project is the better fit.
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
      <TryKiln />
    </>
  )
}

function ComparisonTable() {
  return (
    // Wider than a phone, so it scrolls sideways with the labels pinned.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] table-fixed border-separate border-spacing-0 border-t border-l border-border text-left">
        <caption className="sr-only">
          Kiln compared with other panels, feature by feature
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 w-32 border-r border-b border-border bg-background p-3 align-bottom sm:w-44 sm:p-4"
            >
              <span className="sr-only">Feature</span>
            </th>
            {products.map((product) => (
              <ProductHeading key={product.id} product={product} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th
                scope="row"
                className="sticky left-0 z-10 border-r border-b border-border bg-background p-3 align-top text-sm font-medium text-foreground sm:p-4"
              >
                {row.label}
              </th>
              {products.map((product) => (
                <CellView
                  key={product.id}
                  cell={row.cells[product.id]}
                  highlight={product.id === "kiln"}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProductHeading({ product }: { product: Product }) {
  const kiln = product.id === "kiln"
  return (
    <th
      scope="col"
      className={cn(
        "relative border-r border-b border-border p-4 align-bottom font-normal",
        kiln ? "bg-card" : "bg-background"
      )}
    >
      {kiln ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 -top-px h-0.5 bg-primary"
        />
      ) : null}
      <span className="block text-base font-semibold tracking-[-0.02em] text-foreground">
        {product.id === "kiln" ? (
          product.name
        ) : (
          <a
            href={`#${product.id}`}
            className="underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {product.name}
          </a>
        )}
      </span>
      <span className="type-meta mt-1 block text-muted-foreground">
        {product.kind}
      </span>
    </th>
  )
}

const levelLabels: Record<Cell["level"], string> = {
  yes: "Yes",
  partly: "Partly",
  no: "No",
}

function CellView({ cell, highlight }: { cell: Cell; highlight: boolean }) {
  return (
    <td
      className={cn(
        "border-r border-b border-border p-4 align-top",
        highlight ? "bg-card" : "bg-background"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm">
        {cell.level === "no" ? (
          <Minus aria-hidden="true" className="size-4 text-muted-foreground" />
        ) : (
          <Check
            aria-hidden="true"
            className={cn(
              "size-4",
              cell.level === "yes"
                ? "text-primary-ink"
                : "text-muted-foreground"
            )}
          />
        )}
        <span
          className={
            cell.level === "yes" ? "text-foreground" : "text-muted-foreground"
          }
        >
          {levelLabels[cell.level]}
        </span>
      </span>
      {cell.note ? (
        <span className="type-meta mt-1.5 block text-muted-foreground">
          {cell.note}
        </span>
      ) : null}
    </td>
  )
}

function Alternatives() {
  return (
    <section className="border-t border-border">
      <div className="site-container py-20 sm:py-28">
        <h2 className="site-title max-w-2xl">When to pick which</h2>
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
                    Kiln and {product.name}
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
                <dl className="type-support mt-5 space-y-3 border-t border-border pt-5">
                  <div>
                    <dt className="type-label text-muted-foreground">
                      Pick {product.name} if
                    </dt>
                    <dd className="mt-1 text-foreground">
                      {alternative.pickThem}
                    </dd>
                  </div>
                  <div>
                    <dt className="type-label text-primary-ink">
                      Pick Kiln if
                    </dt>
                    <dd className="mt-1 text-foreground">
                      {alternative.pickKiln}
                    </dd>
                  </div>
                </dl>
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
            Kiln is free, open source, and in early development. It needs only
            Docker.
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
