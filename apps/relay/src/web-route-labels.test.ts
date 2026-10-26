import { describe, expect, it } from "vite-plus/test"

import {
  planWebRouteRecovery,
  webRouteRecoveryLabels,
} from "./web-route-labels.js"

const instanceId = "a".repeat(40)

/** Recovers routes from one container's labels on an empty Relay. */
function recoverFromLabels(labels: Record<string, string>) {
  return planWebRouteRecovery(
    [],
    [{ instanceId, labels, service: "kiln-aaaaaaaa" }]
  )
}

describe("Relay web route recovery labels", () => {
  it("encodes the compact label format", () => {
    expect(
      webRouteRecoveryLabels([
        {
          hostname: "mc.donutsmp.com",
          id: "b00d4423",
          name: "Live Map",
          path: "/map",
          stripPrefix: true,
          httpsRedirect: true,
          primary: false,
          redirect: null,
          www: "none" as const,
          targetPort: 8_080,
        },
        {
          hostname: "admin.donutsmp.com",
          id: "decafbad",
          name: "Admin Panel",
          path: "/admin",
          stripPrefix: false,
          httpsRedirect: true,
          primary: false,
          redirect: null,
          www: "none" as const,
          targetPort: 3_000,
        },
      ])
    ).toEqual({
      "kiln.relay.web-routes.b00d4423":
        "mc.donutsmp.com:8080/map|name=Live%20Map",
      "kiln.relay.web-routes.decafbad":
        "admin.donutsmp.com:3000/admin|name=Admin%20Panel,keep-prefix",
    })
  })

  it("recovers a route's www, HTTP, primary, and redirect options", () => {
    const routes = [
      {
        hostname: "donutsmp.com",
        httpsRedirect: false,
        id: "b00d4423",
        name: "",
        path: null,
        primary: true,
        redirect: null,
        stripPrefix: true,
        targetPort: 8_080,
        www: "redirect" as const,
      },
      {
        hostname: "donut-smp.net",
        httpsRedirect: true,
        id: "decafbad",
        name: "Old name",
        path: "/shop",
        primary: false,
        redirect: {
          permanent: false,
          preservePath: false,
          to: "https://donutsmp.com/store?ref=old,a|b",
        },
        stripPrefix: true,
        targetPort: null,
        www: "serve" as const,
      },
    ]
    const plan = recoverFromLabels(webRouteRecoveryLabels(routes))

    expect(plan.warnings).toEqual([])
    expect(plan.recoveries[0]?.routes).toEqual(routes)
  })

  it("still reads a route without a port as invalid unless it redirects", () => {
    const plan = recoverFromLabels({
      "kiln.relay.web-routes.b00d4423": "donutsmp.com|name=Site",
    })

    expect(plan.recoveries).toEqual([])
    expect(plan.warnings).toHaveLength(1)
  })

  it("skips a label whose route breaks a saved route's rules", () => {
    const plan = recoverFromLabels({
      "kiln.relay.web-routes.b00d4423":
        "donutsmp.com:8080|name=Site,redirect=https%3A%2F%2Fnew.example.com",
      "kiln.relay.web-routes.decafbad": "map.donutsmp.com:8100|name=Map",
    })

    expect(plan.recoveries[0]?.routes.map((route) => route.id)).toEqual([
      "decafbad",
    ])
    expect(plan.warnings).toHaveLength(1)
  })

  it("recovers routes from labels and ignores the revision marker", () => {
    const plan = recoverFromLabels({
      "kiln.relay.web-routes.b00d4423":
        "mc.donutsmp.com:8080/map|name=Live%20Map",
      "kiln.relay.web-routes.decafbad":
        "admin.donutsmp.com:3000/admin|name=Admin%20Panel,keep-prefix",
      "kiln.relay.web-routes.revision": "abc123",
      "other.label": "ignored",
    })

    expect(plan.warnings).toEqual([])
    expect(plan.recoveries[0]?.routes).toEqual([
      {
        hostname: "mc.donutsmp.com",
        id: "b00d4423",
        name: "Live Map",
        path: "/map",
        stripPrefix: true,
        httpsRedirect: true,
        primary: false,
        redirect: null,
        www: "none" as const,
        targetPort: 8_080,
      },
      {
        hostname: "admin.donutsmp.com",
        id: "decafbad",
        name: "Admin Panel",
        path: "/admin",
        stripPrefix: false,
        httpsRedirect: true,
        primary: false,
        redirect: null,
        www: "none" as const,
        targetPort: 3_000,
      },
    ])
  })

  it("keeps persisted routes authoritative", () => {
    const persisted = [
      {
        hostname: "new.example.com",
        id: "cafebabe",
        instanceId,
        name: "New Route",
        path: null,
        stripPrefix: true,
        httpsRedirect: true,
        primary: false,
        redirect: null,
        www: "none" as const,
        targetPort: 8_080,
      },
    ]
    const plan = planWebRouteRecovery(persisted, [
      {
        instanceId,
        labels: {
          "kiln.relay.web-routes.b00d4423": "old.example.com:8080",
        },
        service: "kiln-aaaaaaaa",
      },
    ])

    expect(plan).toEqual({ recoveries: [], warnings: [] })
  })

  it("rejects Relay-local collisions while recovering other routes", () => {
    const plan = planWebRouteRecovery(
      [],
      [
        {
          instanceId,
          labels: {
            "kiln.relay.web-routes.b00d4423": "mc.donutsmp.com:8080/map",
          },
          service: "kiln-aaaaaaaa",
        },
        {
          instanceId: "b".repeat(40),
          labels: {
            "kiln.relay.web-routes.b00d4423": "admin.donutsmp.com:3000",
            "kiln.relay.web-routes.decafbad": "mc.donutsmp.com:9000/map",
            "kiln.relay.web-routes.facefeed": "valid.donutsmp.com:9000",
          },
          service: "kiln-bbbbbbbb",
        },
      ]
    )

    expect(plan.recoveries).toHaveLength(2)
    expect(plan.recoveries[1]?.routes).toEqual([
      {
        hostname: "valid.donutsmp.com",
        id: "facefeed",
        name: "valid.donutsmp.com",
        path: null,
        stripPrefix: true,
        httpsRedirect: true,
        primary: false,
        redirect: null,
        www: "none" as const,
        targetPort: 9_000,
      },
    ])
    expect(plan.warnings).toHaveLength(2)
  })

  it("skips malformed labels without blocking Relay startup", () => {
    const plan = recoverFromLabels({
      "kiln.relay.web-routes.not-an-id": "mc.donutsmp.com:8080",
      "kiln.relay.web-routes.b00d4423":
        "mc.donutsmp.com:8080/map|unknown-option",
      "kiln.relay.web-routes.decafbad": "valid.donutsmp.com:9000",
    })

    expect(plan.recoveries[0]?.routes.map((route) => route.id)).toEqual([
      "decafbad",
    ])
    expect(plan.warnings).toHaveLength(2)
  })
})
