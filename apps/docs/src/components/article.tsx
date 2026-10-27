import * as React from "react"
import { useRouter } from "@tanstack/react-router"

import { basePath } from "~/lib/base"

// A page's HTML, built from its Markdown at build time. One listener handles
// every code block's copy button and keeps links between pages inside the app.
export function Article({ html }: { html: string }) {
  const router = useRouter()
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const timers = new Set<number>()
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return

      const copy = target.closest<HTMLButtonElement>("[data-copy-code]")
      if (copy) {
        const code = copy.closest("figure")?.querySelector("pre")?.innerText
        if (!code) return
        void navigator.clipboard.writeText(code.replace(/\n$/, "")).then(() => {
          copy.textContent = "Copied"
          copy.dataset.copied = ""
          const timer = window.setTimeout(() => {
            copy.textContent = "Copy"
            delete copy.dataset.copied
            timers.delete(timer)
          }, 1600)
          timers.add(timer)
        })
        return
      }

      const link = target.closest<HTMLAnchorElement>("a[href]")
      if (
        !link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target
      ) {
        return
      }
      const url = new URL(link.href)
      if (url.origin !== window.location.origin) return
      const inDocs =
        url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)
      if (!inDocs) return
      // A heading on this page: let the browser jump to it.
      if (url.pathname === window.location.pathname && url.hash) return
      event.preventDefault()
      router.history.push(`${url.pathname}${url.search}${url.hash}`)
    }
    element.addEventListener("click", onClick)
    return () => {
      element.removeEventListener("click", onClick)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [router])

  return (
    <div
      ref={ref}
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
