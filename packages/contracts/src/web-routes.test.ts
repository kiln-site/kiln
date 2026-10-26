import { describe, expect, it } from "vite-plus/test"

import { relayInstanceWebRouteInputsSchema } from "./index.js"

const redirect = (path: string | null, to: string, preservePath: boolean) => ({
  hostname: "example.com",
  path,
  redirect: { permanent: true, preservePath, to },
  targetPort: null,
})

describe("web route redirects", () => {
  it("refuses a redirect that lands back on its own route", () => {
    for (const route of [
      redirect(null, "https://example.com/new", true),
      redirect(null, "https://www.example.com/", false),
      redirect("/a/a", "https://example.com/a", true),
      redirect("/blog", "https://example.com/blog/archive", false),
    ]) {
      const parsed = relayInstanceWebRouteInputsSchema.safeParse([
        {
          ...route,
          www: route.redirect.to.includes("www.") ? "redirect" : "none",
        },
      ])
      expect(parsed.success, JSON.stringify(route)).toBe(false)
    }
  })

  it("accepts a redirect to another path or host", () => {
    for (const route of [
      redirect("/blog", "https://example.com/news", true),
      redirect("/blog", "https://example.com/", false),
      redirect(null, "https://example.org/", true),
    ]) {
      expect(
        relayInstanceWebRouteInputsSchema.safeParse([route]).success,
        JSON.stringify(route)
      ).toBe(true)
    }
  })
})
