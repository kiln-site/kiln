export type BillingInterval = "month" | "year"

export interface Plan {
  id: "self-hosted" | "plus" | "pro"
  name: string
  summary: string
  monthly: number
  // Billed once a year; the page shows it as a monthly figure.
  yearly: number
  features: Array<string>
}

export const plans: Array<Plan> = [
  {
    id: "self-hosted",
    name: "Self-hosted",
    summary: "Run Hearth and every Relay on hardware you control.",
    monthly: 0,
    yearly: 0,
    features: [
      "Everything in Kiln, no limits",
      "Unlimited Relays and instances",
      "Backups to your own storage",
      "Community help on Discord",
    ],
  },
  {
    id: "plus",
    name: "Plus",
    summary: "We run Hearth for you. Your machines run the instances.",
    monthly: 8,
    yearly: 80,
    features: [
      "Hosted Hearth, updated for you",
      "Up to 3 Relays",
      "Unlimited game servers, apps, and databases",
      "Nightly backups of your panel",
      "Email support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    summary: "For communities and teams sharing the work.",
    monthly: 24,
    yearly: 240,
    features: [
      "Everything in Plus",
      "Up to 20 Relays",
      "Roles and per-instance permissions",
      "A year of activity history",
      "Priority support",
    ],
  },
]

// Hearth's sign-in page opens in sign-up mode with `signup`, and after the
// account exists it follows `redirect`. `plan` and `interval` sit at the top
// level so the sign-up screen can name the plan, and in the redirect so the
// billing page knows what to buy.
export function planSignupUrl(
  hearthUrl: string,
  plan: Plan["id"],
  interval: BillingInterval
): string {
  const selection = new URLSearchParams({ plan, interval })
  const url = new URL("/", hearthUrl)
  url.searchParams.set("signup", "true")
  url.searchParams.set("plan", plan)
  url.searchParams.set("interval", interval)
  url.searchParams.set("redirect", `/settings/billing?${selection}`)
  return url.toString()
}

export function signInUrl(hearthUrl: string): string {
  return new URL("/", hearthUrl).toString()
}

export function signUpUrl(hearthUrl: string): string {
  const url = new URL("/", hearthUrl)
  url.searchParams.set("signup", "true")
  return url.toString()
}
