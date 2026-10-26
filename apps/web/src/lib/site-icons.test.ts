import { describe, expect, it } from "vite-plus/test"

import { siteIconCandidates } from "@/lib/site-icons"

describe("siteIconCandidates", () => {
  it("orders a page's icons largest first, resolved against the page", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel='apple-touch-icon' href='touch.png'>
      <link href="https://cdn.example.com/icon-512.png" rel="icon" sizes="192x192 512x512" />
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="stylesheet" href="/site.css">
    </head></html>`
    expect(siteIconCandidates(html, "https://app.example.com/dash/")).toEqual([
      { size: 512, url: "https://cdn.example.com/icon-512.png" },
      { size: 180, url: "https://app.example.com/dash/touch.png" },
      { size: 32, url: "https://app.example.com/favicon-32.png" },
    ])
  })

  it("counts scalable icons as the largest", () => {
    const html = `<link rel="icon" href="/logo.svg"><link rel="icon" sizes="256x256" href="/big.png">`
    expect(siteIconCandidates(html, "https://example.com/")[0]).toEqual({
      size: 4096,
      url: "https://example.com/logo.svg",
    })
  })

  it("follows the page's base address", () => {
    const html = `<base href="https://static.example.com/assets/"><link rel="shortcut icon" href="fav.ico">`
    expect(siteIconCandidates(html, "https://example.com/")).toEqual([
      { size: 32, url: "https://static.example.com/assets/fav.ico" },
    ])
  })

  it("leaves out anything but HTTPS addresses", () => {
    const html = `
      <link rel="icon" href="http://example.com/insecure.png">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="icon" href="file:///etc/passwd">
      <link rel="icon" href="https://example.com/ok.png">`
    expect(siteIconCandidates(html, "https://example.com/")).toEqual([
      { size: 32, url: "https://example.com/ok.png" },
    ])
  })

  it("decodes entities in addresses", () => {
    const html = `<link rel="icon" href="/icon.png?a=1&amp;b=2">`
    expect(siteIconCandidates(html, "https://example.com/")[0]?.url).toBe(
      "https://example.com/icon.png?a=1&b=2"
    )
  })
})
