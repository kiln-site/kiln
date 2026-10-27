import { createFileRoute } from "@tanstack/react-router"

import { markdownFor, textHeaders } from "~/lib/markdown-pages"

// A page's Markdown, at /docs/markdown/<page>. "Copy page" copies it.
export const Route = createFileRoute("/markdown/$")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const markdown = markdownFor(
          `/${params._splat ?? ""}`.replace(/\/+$/, "") || "/"
        )
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
