import { createFileRoute } from "@tanstack/react-router"
import { Check } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { ComingSoon } from "~/components/coming-soon"
import {
  type BillingInterval,
  type Plan,
  planSignupUrl,
  plans,
} from "~/lib/plans"
import { comingSoon } from "~/lib/coming-soon"
import { newTab } from "~/lib/new-tab"
import { pageHead } from "~/lib/seo"
import { useSiteConfig } from "~/lib/use-site-config"

export const Route = createFileRoute("/pricing")({
  // Monthly is the default, so only a yearly choice shows in the URL.
  validateSearch: (search: Record<string, unknown>): { interval?: "year" } =>
    search.interval === "year" ? { interval: "year" } : {},
  head: ({ matches }) =>
    pageHead({
      description:
        "Self-host Kiln for free, or let us run the panel while your machines run everything else.",
      matches,
      path: "/pricing",
      title: "Pricing | Kiln",
    }),
  component: PricingPage,
})

const recommendedPlan: Plan["id"] = "plus"

function PricingPage() {
  const { interval = "month" } = Route.useSearch()

  return (
    <>
      {/* Short enough that the plans fit on one screen with it. */}
      <section className="site-container flex flex-col gap-6 pt-10 pb-8 sm:pt-14 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="site-title">Pay for the panel, not the hardware.</h1>
          <p className="site-copy mt-3 max-w-xl text-muted-foreground">
            Your game servers, apps, and databases run on machines you already
            have. Self-host all of Kiln for free, or let us run Hearth for you.
          </p>
        </div>
        <IntervalSwitch interval={interval} />
      </section>

      <section className="site-container pb-20 sm:pb-28">
        <ol className="grid gap-px border border-border bg-border lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanColumn key={plan.id} interval={interval} plan={plan} />
          ))}
        </ol>
        <p className="type-support mt-6 text-muted-foreground">
          Prices in US dollars. Need more Relays, or a commercial license to
          build on Kiln? Email{" "}
          <a
            href="mailto:contact@kiln.site"
            className="text-foreground underline underline-offset-4 hover:text-primary-ink"
          >
            contact@kiln.site
          </a>
          .
        </p>
      </section>

      <Questions />
    </>
  )
}

function IntervalSwitch({ interval }: { interval: BillingInterval }) {
  const navigate = Route.useNavigate()
  const optionClassName =
    "flex h-9 items-center gap-2 px-3.5 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-accent aria-pressed:text-foreground"
  function choose(next: BillingInterval) {
    void navigate({
      search: next === "year" ? { interval: "year" } : {},
      replace: true,
      resetScroll: false,
    })
  }
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex shrink-0 self-start border border-border bg-card p-0.5 lg:self-auto"
    >
      <button
        type="button"
        aria-pressed={interval === "month"}
        className={optionClassName}
        onClick={() => choose("month")}
      >
        Monthly
      </button>
      <button
        type="button"
        aria-pressed={interval === "year"}
        className={optionClassName}
        onClick={() => choose("year")}
      >
        Yearly
        <span className="type-label text-primary-ink">2 months free</span>
      </button>
    </div>
  )
}

function PlanColumn({
  interval,
  plan,
}: {
  interval: BillingInterval
  plan: Plan
}) {
  const { docsUrl, hearthUrl } = useSiteConfig()
  const recommended = plan.id === recommendedPlan
  const free = plan.monthly === 0
  const price = interval === "year" ? plan.yearly / 12 : plan.monthly

  return (
    <li
      className={cn(
        "relative flex flex-col bg-background p-6 sm:p-7",
        recommended && "bg-card"
      )}
    >
      {recommended ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 -top-px h-0.5 bg-primary"
        />
      ) : null}
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-[-0.03em]">
          {plan.name}
        </h2>
        {recommended ? (
          <span className="type-label text-primary-ink">Recommended</span>
        ) : null}
      </div>
      <p className="type-support mt-2 min-h-10 text-muted-foreground">
        {plan.summary}
      </p>

      <p className="mt-5 flex items-baseline gap-2">
        <span className="text-5xl font-semibold tracking-[-0.05em] tabular-nums">
          ${formatPrice(price)}
        </span>
        <span className="type-support text-muted-foreground">
          {free ? "forever" : "per month"}
        </span>
      </p>
      <p className="type-meta mt-2 h-4 text-muted-foreground">
        {free
          ? "Open source under AGPL-3.0"
          : interval === "year"
            ? `$${plan.yearly} billed once a year`
            : `Or $${plan.yearly} a year`}
      </p>

      <div className="mt-6">
        <ComingSoon
          soon={free ? comingSoon.docs : comingSoon.paidPlans}
          label={free ? "Read the install guide" : `Choose ${plan.name}`}
          className="flex"
        >
          <Button
            asChild
            variant={recommended ? "default" : "outline"}
            className="h-11 w-full text-[0.9375rem]"
          >
            {free ? (
              <a
                href={new URL("/self-hosting", docsUrl).toString()}
                {...newTab}
              >
                Read the install guide
              </a>
            ) : (
              <a href={planSignupUrl(hearthUrl, plan.id, interval)}>
                {comingSoon.paidPlans ? "Coming soon" : `Choose ${plan.name}`}
              </a>
            )}
          </Button>
        </ComingSoon>
      </div>

      <ul className="type-support mt-6 space-y-2.5 border-t border-border pt-5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-primary-ink" />
            {feature}
          </li>
        ))}
      </ul>
    </li>
  )
}

function formatPrice(price: number) {
  return Number.isInteger(price) ? String(price) : price.toFixed(2)
}

const questions = [
  {
    question: "Do I need my own hardware?",
    answer:
      "Yes. Kiln runs your instances on machines you control: a rented dedicated server, a VPS, or a computer at home. Each one runs a Relay with Docker. The paid plans host Hearth, the panel, so there’s one less thing to keep running.",
  },
  {
    question: "What counts as a Relay?",
    answer:
      "One machine running the Relay. It can run as many game servers, apps, and databases as its hardware allows; plans only count the machines.",
  },
  {
    question: "Can I move between hosted and self-hosted?",
    answer:
      "Yes. Your instances already live on your machines. Moving only changes where Hearth runs, and a platform backup carries your panel’s settings with it.",
  },
  {
    question: "What happens if I cancel?",
    answer:
      "Your Relays and everything on them keep running. You can self-host Hearth for free and pair it with the same machines.",
  },
]

function Questions() {
  return (
    <section className="border-t border-border">
      <div className="site-container grid gap-10 py-20 sm:py-28 lg:grid-cols-12 lg:gap-16">
        <h2 className="site-title lg:col-span-4">Questions</h2>
        <div className="divide-y divide-border border-y border-border lg:col-span-8">
          {questions.map((item) => (
            <details key={item.question} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-base font-medium outline-none focus-visible:text-primary-ink [&::-webkit-details-marker]:hidden">
                {item.question}
                <span
                  aria-hidden="true"
                  className="relative size-3 shrink-0 text-muted-foreground before:absolute before:top-1/2 before:left-0 before:h-px before:w-3 before:bg-current after:absolute after:top-0 after:left-1/2 after:h-3 after:w-px after:bg-current group-open:after:hidden"
                />
              </summary>
              <p className="site-copy max-w-2xl pb-6 text-muted-foreground">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
