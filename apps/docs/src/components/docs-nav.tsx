import { Link } from "@tanstack/react-router"

import { cn } from "@workspace/ui/lib/utils"

import { sections } from "~/lib/pages"

// Every section and its pages: the sidebar on wide screens, and the menu
// drawer on phones.
export function DocsNav({
  className,
  onNavigate,
}: {
  className?: string
  onNavigate?: () => void
}) {
  return (
    <nav aria-label="Docs" className={cn("flex flex-col gap-7", className)}>
      {sections.map((section) => {
        const Icon = section.icon
        return (
          <div key={section.id}>
            <h2 className="type-technical-label flex items-center gap-2 px-3 text-muted-foreground">
              <Icon aria-hidden="true" className="size-3.5 text-primary-ink" />
              {section.title}
            </h2>
            <ul className="mt-2 flex flex-col border-l border-border">
              {section.entries.map((page) => (
                <li key={page.path}>
                  <Link
                    to="/$"
                    params={{ _splat: page.path.replace(/^\//, "") }}
                    onClick={onNavigate}
                    activeOptions={{ exact: true, includeHash: false }}
                    className="-ml-px block border-l border-transparent py-1.5 pr-2 pl-3 text-sm text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:text-foreground focus-visible:text-foreground focus-visible:underline data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground"
                  >
                    {page.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
