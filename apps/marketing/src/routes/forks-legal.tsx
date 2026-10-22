import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"

import { LegalPage } from "~/components/legal-page"

// A fork's panel links its Terms and Privacy here, naming itself in `from`.
export const Route = createFileRoute("/forks-legal")({
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" ? { from: search.from } : {},
  head: () => ({
    meta: [
      { title: "This panel isn’t run by Kiln | Kiln" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ForksLegalPage,
})

function ForksLegalPage() {
  const { from } = Route.useSearch()
  const referrer = useReferrer()
  const panel = hostOf(from) ?? hostOf(referrer)

  return (
    <LegalPage title="This panel isn’t run by Kiln">
      <p>
        You followed a legal link from{" "}
        {panel ? (
          <span className="font-mono break-all text-foreground">{panel}</span>
        ) : (
          "a panel"
        )}
        , which runs a fork of Kiln that someone else builds and operates. Kiln
        is open source, so anyone can make their own version.
      </p>
      <p>
        QuartzDev doesn’t operate forks and isn’t responsible for them, what
        they host, or how they handle your data. Each one needs its own terms of
        use and privacy policy. Send any questions or requests, including about
        your account or data, to whoever runs it.
      </p>
      <p>
        Kiln’s <Link to="/terms">Terms of Use</Link> and{" "}
        <Link to="/privacy">Privacy Policy</Link> don’t apply to forks.
      </p>
    </LegalPage>
  )
}

// A panel that doesn't name itself may still have sent its address.
function useReferrer(): string | undefined {
  const [referrer, setReferrer] = React.useState<string>()
  React.useEffect(() => {
    const value = document.referrer
    if (value && new URL(value).origin !== location.origin) setReferrer(value)
  }, [])
  return referrer
}

// Only a web address's host is shown, as text, so the page can't be made to
// say anything else.
function hostOf(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  return url.host
}
