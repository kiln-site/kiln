import { createFileRoute } from "@tanstack/react-router"

import { getSiteConfig } from "~/lib/site-config"
import { pageUrl, pagesInOrder } from "~/lib/markdown-pages"

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const { siteUrl } = await getSiteConfig()
        const urls = pagesInOrder().map((page) => pageUrl(siteUrl, page.path))
        const body = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
          "</urlset>",
          "",
        ].join("\n")
        return new Response(body, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Content-Type": "application/xml; charset=utf-8",
          },
        })
      },
    },
  },
})
