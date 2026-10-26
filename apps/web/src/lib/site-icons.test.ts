import { describe, expect, it } from "vite-plus/test"

import {
  conventionalIcons,
  rankSiteIcons,
  readManifestIcons,
  readSitePage,
} from "@/lib/site-icons"

describe("readSitePage", () => {
  it("finds a page's icons and manifest, resolved against the page", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel='apple-touch-icon' href='touch.png'>
      <link href="https://cdn.example.com/icon-512.png" rel="icon" sizes="192x192 512x512" />
      <link rel="manifest" href="/site.webmanifest">
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="stylesheet" href="/site.css">
    </head></html>`
    expect(readSitePage(html, "https://app.example.com/dash/")).toEqual({
      icons: [
        { size: 32, url: "https://app.example.com/favicon-32.png" },
        { size: 180, url: "https://app.example.com/dash/touch.png" },
        { size: 512, url: "https://cdn.example.com/icon-512.png" },
      ],
      manifestUrl: "https://app.example.com/site.webmanifest",
    })
  })

  it("follows the page's base address", () => {
    const html = `<base href="https://static.example.com/assets/"><link rel="shortcut icon" href="fav.ico">`
    expect(readSitePage(html, "https://example.com/").icons).toEqual([
      { size: 32, url: "https://static.example.com/assets/fav.ico" },
    ])
  })

  it("leaves out anything but HTTPS addresses", () => {
    const html = `
      <link rel="icon" href="http://example.com/insecure.png">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="manifest" href="file:///etc/passwd">
      <link rel="icon" href="https://example.com/ok.png">`
    expect(readSitePage(html, "https://example.com/")).toEqual({
      icons: [{ size: 32, url: "https://example.com/ok.png" }],
      manifestUrl: null,
    })
  })

  it("decodes entities in addresses", () => {
    const html = `<link rel="icon" href="/icon.png?a=1&amp;b=2">`
    expect(readSitePage(html, "https://example.com/").icons[0]?.url).toBe(
      "https://example.com/icon.png?a=1&b=2"
    )
  })
})

describe("readManifestIcons", () => {
  it("reads a manifest's icons, counting maskable ones as smaller", () => {
    const manifest = {
      icons: [
        { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/mask.png", sizes: "512x512", purpose: "maskable" },
        { src: "/icons/mono.png", sizes: "512x512", purpose: "monochrome" },
        { src: "http://example.com/insecure.png", sizes: "1024x1024" },
      ],
    }
    expect(
      readManifestIcons(manifest, "https://example.com/app/manifest.json")
    ).toEqual([
      { size: 512, url: "https://example.com/icons/512.png" },
      { size: 256, url: "https://example.com/icons/mask.png" },
    ])
  })

  it("ignores manifests that aren't shaped like one", () => {
    expect(readManifestIcons("nope", "https://example.com/m.json")).toEqual([])
    expect(
      readManifestIcons({ icons: "nope" }, "https://example.com/m.json")
    ).toEqual([])
  })
})

describe("rankSiteIcons", () => {
  it("puts the largest first, and a named icon before a guessed one", () => {
    const ranked = rankSiteIcons([
      { size: 32, url: "https://example.com/favicon.ico" },
      { size: 180, url: "https://example.com/touch.png" },
      ...conventionalIcons("https://example.com/dash/"),
    ])
    expect(ranked.slice(0, 3).map((icon) => icon.url)).toEqual([
      "https://example.com/favicon.svg",
      "https://example.com/icon.svg",
      "https://example.com/android-chrome-512x512.png",
    ])
    // The page named its favicon, so it isn't a guess any more.
    expect(
      ranked.find((icon) => icon.url === "https://example.com/favicon.ico")
    ).toEqual({ size: 32, url: "https://example.com/favicon.ico" })
    const touch = ranked.findIndex(
      (icon) => icon.url === "https://example.com/touch.png"
    )
    const guessedTouch = ranked.findIndex(
      (icon) => icon.url === "https://example.com/apple-touch-icon.png"
    )
    expect(touch).toBeLessThan(guessedTouch)
  })
})
