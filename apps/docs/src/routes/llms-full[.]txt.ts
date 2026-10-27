import { createFileRoute } from "@tanstack/react-router"

import { getSiteConfig } from "~/lib/site-config"
import {
  markdownFor,
  pageUrl,
  pagesInOrder,
  textHeaders,
} from "~/lib/markdown-pages"

// Every page of the docs in one Markdown file, for AI assistants.
export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () => {
        const { siteUrl } = await getSiteConfig()
        const body = pagesInOrder()
          .map(
            (page) =>
              `${markdownFor(page.path) ?? ""}\nSource: ${pageUrl(siteUrl, page.path)}\n`
          )
          .join("\n---\n\n")
        return new Response(body, { headers: textHeaders })
      },
    },
  },
})
