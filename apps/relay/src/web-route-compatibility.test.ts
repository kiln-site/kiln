import { relayWebRouteOptionsV1Feature } from "@workspace/contracts"
import type { RelayInstanceWebRoute } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  webRoutesForHearth,
  webRoutesFromHearth,
} from "./web-route-compatibility.js"

const site: RelayInstanceWebRoute = {
  hostname: "donutsmp.com",
  httpsRedirect: false,
  id: "b00d4423",
  name: "",
  path: null,
  primary: true,
  redirect: null,
  stripPrefix: true,
  targetPort: 8080,
  www: "redirect",
}
const oldDomain: RelayInstanceWebRoute = {
  ...site,
  hostname: "donut-smp.net",
  id: "decafbad",
  primary: false,
  redirect: {
    permanent: true,
    preservePath: true,
    to: "https://donutsmp.com/",
  },
  targetPort: null,
  www: "none",
}
const olderHearth = new Set<string>()

describe("web routes for a Hearth that predates route options", () => {
  it("reads named routes with a port, without options or redirects", () => {
    expect(webRoutesForHearth(olderHearth, [site, oldDomain])).toEqual([
      {
        hostname: "donutsmp.com",
        id: "b00d4423",
        name: "donutsmp.com",
        path: null,
        stripPrefix: true,
        targetPort: 8080,
      },
    ])
  })

  it("keeps options and redirects it never saw when it saves", () => {
    const saved = [
      { ...site, instanceId: "a".repeat(40) },
      { ...oldDomain, instanceId: "a".repeat(40) },
    ]
    // The older Hearth changes the port of the route it was shown.
    const edited = {
      hostname: "donutsmp.com",
      httpsRedirect: true,
      id: "b00d4423",
      name: "donutsmp.com",
      path: null,
      primary: false,
      redirect: null,
      stripPrefix: true,
      targetPort: 9090,
      www: "none" as const,
    }

    expect(webRoutesFromHearth(olderHearth, [edited], saved)).toEqual([
      { ...site, targetPort: 9090 },
      oldDomain,
    ])
  })

  it("leaves a current Hearth's routes as it sent them", () => {
    const current = new Set([relayWebRouteOptionsV1Feature])

    expect(webRoutesForHearth(current, [site, oldDomain])).toEqual([
      site,
      oldDomain,
    ])
    expect(webRoutesFromHearth(current, [site], [oldDomain])).toEqual([site])
  })
})
