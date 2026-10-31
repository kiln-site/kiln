import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import type { Heading } from "../../content-plugin"

// "On this page": the page's headings, with the one being read marked. Only
// this list re-renders as the reader scrolls.
export function TableOfContents({ headings }: { headings: Array<Heading> }) {
  const active = useActiveHeading(headings)
  if (headings.length === 0) return null
  return (
    <nav aria-label="On this page">
      <p className="type-technical-label text-muted-foreground">On this page</p>
      <ul className="mt-3 flex flex-col border-l border-border text-sm">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              aria-current={heading.id === active ? "location" : undefined}
              className={cn(
                "-ml-px block border-l border-transparent py-1 pr-2 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground aria-[current=location]:border-primary aria-[current=location]:text-foreground",
                heading.depth === 3 ? "pl-6" : "pl-3"
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// The last heading scrolled past the top quarter of the screen.
function useActiveHeading(headings: Array<Heading>): string | undefined {
  const [active, setActive] = React.useState<string | undefined>(
    headings[0]?.id
  )
  React.useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return
    let frame: number | null = null
    const update = () => {
      frame = null
      const line = window.innerHeight * 0.25
      let current: string | undefined = elements[0]?.id
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= line) current = element.id
        else break
      }
      // At the very bottom, the last heading may never reach the line.
      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2
      ) {
        current = elements.at(-1)?.id
      }
      setActive(current)
    }
    const schedule = () => {
      frame ??= requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [headings])
  return active
}
