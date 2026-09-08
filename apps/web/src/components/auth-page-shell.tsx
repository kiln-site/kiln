import type { ReactNode } from "react"
import { HearthMark } from "@/components/hearth-mark"

export function AuthPageShell({
  children,
  wide = false,
}: {
  children: ReactNode
  wide?: boolean
}) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-6 md:p-10">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_40%,black,transparent)] bg-[size:64px_64px]" />
      <div className="pointer-events-none absolute top-[22%] left-1/2 h-44 w-72 -translate-x-1/2 rounded-full bg-primary/5 blur-[100px]" />
      <section className={`relative w-full ${wide ? "max-w-2xl" : "max-w-sm"}`}>
        {children}
      </section>
    </main>
  )
}

export function AuthBrand() {
  return (
    <div className="flex items-center justify-center gap-3">
      <HearthMark className="size-11" />
      <span className="font-heading text-3xl font-semibold tracking-[-0.04em]">
        Kiln
      </span>
    </div>
  )
}
