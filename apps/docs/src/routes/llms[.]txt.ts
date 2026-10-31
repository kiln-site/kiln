import { createFileRoute } from "@tanstack/react-router"

import { getSiteConfig } from "~/lib/site-config"
import { pageUrl, pagesInOrder, textHeaders } from "~/lib/markdown-pages"
import { markdownPath } from "~/lib/base"
import { sections } from "~/lib/pages"

// An index of the docs for AI assistants (llmstxt.org): every page with a
// link to its Markdown.
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () => {
        const { siteUrl } = await getSiteConfig()
        const pages = new Map(pagesInOrder().map((page) => [page.path, page]))
        const lines = [
          "# Kiln Docs",
          "",
          "> Kiln is a free, open-source panel for game servers, apps, and databases, running on machines you own. Hearth is the web panel; a Relay runs on each machine and runs the containers.",
          "",
          `The complete docs in one file: ${pageUrl(siteUrl, "/llms-full.txt")}`,
        ]
        for (const section of sections) {
          lines.push("", `## ${section.title}`, "")
          for (const entry of section.entries) {
            const page = pages.get(entry.path)
            if (!page) continue
            lines.push(
              `- [${page.title}](${pageUrl(siteUrl, markdownPath(page.path))}): ${page.description}`
            )
          }
        }
        return new Response(`${lines.join("\n")}\n`, { headers: textHeaders })
      },
    },
  },
})
