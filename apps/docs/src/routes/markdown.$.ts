import { createFileRoute } from "@tanstack/react-router"

import { markdownFor, textHeaders } from "~/lib/markdown-pages"

// A page's Markdown, at /docs/markdown/<page>. "Copy page" copies it.
export const Route = createFileRoute("/markdown/$")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const splat = (params._splat ?? "").replace(/\/+$/, "")
        const markdown = markdownFor(splat === "index" ? "/" : `/${splat}`)
        return markdown
          ? new Response(markdown, {
              headers: {
                ...textHeaders,
                "Content-Type": "text/markdown; charset=utf-8",
              },
            })
          : new Response("Not found\n", { status: 404, headers: textHeaders })
      },
    },
  },
})
