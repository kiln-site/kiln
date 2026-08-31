import { describe, expect, it } from "vite-plus/test"

import {
  relayProxyBrowserMetadataSchema,
  relayProxyReadInputSchema,
} from "./index.js"

describe("Relay proxy browser metadata", () => {
  it("keeps diagnostics enabled unless a caller explicitly opts out", () => {
    expect(relayProxyReadInputSchema.parse({})).toEqual({
      includeDiagnostics: true,
    })
    expect(
      relayProxyReadInputSchema.parse({ includeDiagnostics: false })
    ).toEqual({ includeDiagnostics: false })
  })

  it("validates the lightweight browser connection response", () => {
    expect(
      relayProxyBrowserMetadataSchema.parse({
        browserOrigin: "https://relay.kiln.test",
        mode: "traefik",
      })
    ).toEqual({
      browserOrigin: "https://relay.kiln.test",
      mode: "traefik",
    })
  })
})
