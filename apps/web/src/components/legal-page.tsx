import type { ReactNode } from "react"

import { HearthMark } from "@/components/hearth-mark"
import { PanelFooter } from "@/components/panel-footer"

export function LegalPage({
  children,
  title,
  updated,
}: {
  children: ReactNode
  title: string
  updated: string
}) {
  return (
    <main className="h-dvh overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 py-6 sm:px-8 sm:py-8">
        <header className="flex items-center justify-between border-b border-border/70 pb-4">
          <a
            href="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
          >
            <HearthMark className="size-7" />
            Hearth Panel
          </a>
          <a
            href="/"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          >
            Back to panel
          </a>
        </header>

        <article className="mx-auto w-full max-w-2xl flex-1 py-12 sm:py-16">
          <p className="type-technical-label text-primary">
            QuartzDev · Hearth Panel
          </p>
          <h1 className="mt-3 font-heading text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 text-xs text-muted-foreground">
            Effective {updated}
          </p>
          <div className="type-support mt-10 max-w-[65ch] space-y-8 text-muted-foreground">
            {children}
          </div>
        </article>

        <PanelFooter className="-mx-5 w-[calc(100%+2.5rem)] sm:mx-0 sm:w-full" />
      </div>
    </main>
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
      <h2 className="font-heading text-base font-semibold tracking-[-0.02em] text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-primary/70">
      {children}
    </ul>
  )
}
