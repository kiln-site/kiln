import { Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

export function NotFoundPage() {
  return (
    <section className="site-container py-28 sm:py-40">
      <h1 className="site-title">This page doesn’t exist</h1>
      <p className="site-copy mt-4 max-w-md text-muted-foreground">
        The link may be old, or the address has a typo.
      </p>
      <Button asChild className="mt-8 h-10 px-4">
        <Link to="/">Go to the home page</Link>
      </Button>
    </section>
  )
}
