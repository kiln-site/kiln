import type { ReactNode } from "react"

export function LegalPage({
  children,
  title,
  updated,
}: {
  children: ReactNode
  title: string
  updated?: string
}) {
  return (
    <article className="site-container py-16 sm:py-24">
      <div className="mx-auto max-w-2xl">
        <p className="type-technical-label text-primary-ink">Legal</p>
        <h1 className="site-title mt-3">{title}</h1>
        {updated ? (
          <p className="type-support mt-3 text-muted-foreground">
            Effective {updated}
          </p>
        ) : null}
        <div className="site-copy mt-10 max-w-[65ch] space-y-8 text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary-ink">
          {children}
        </div>
      </div>
    </article>
  )
}

export function LegalSection({
  children,
  title,
}: {
  children: ReactNode
  title: string
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="font-heading text-lg font-semibold tracking-[-0.02em] text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-primary-ink/70">
      {children}
    </ul>
  )
}

// The address for questions, account requests, and licensing.
export function ContactEmail() {
  return <a href="mailto:contact@kiln.site">contact@kiln.site</a>
}
