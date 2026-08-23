import type { LucideIcon } from "lucide-react"

export function SettingsPlaceholderPage({
  description,
  icon: Icon,
  title,
}: {
  description: string
  icon: LucideIcon
  title: string
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-10">
      <section className="grid min-h-56 place-items-center rounded-xl border border-dashed bg-card/25 px-6 text-center">
        <div className="max-w-sm">
          <Icon className="mx-auto size-5 text-primary" />
          <h2 className="mt-4 font-heading text-xl font-semibold">{title}</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
          <p className="type-technical-label mt-4 text-muted-foreground">
            Coming soon
          </p>
        </div>
      </section>
    </div>
  )
}
