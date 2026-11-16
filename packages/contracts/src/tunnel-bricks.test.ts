import { describe, expect, it } from "vite-plus/test"

import { brickRecipeSchema } from "./brick-recipe.js"
import { tunnelBrickImages, tunnelBrickProblem } from "./tunnel-bricks.js"

// As Kiln's catalog has it (`apps/bricks/bricks/tailscale.yml`).
const tailscale = {
  format: "kiln.brick/v2",
  kind: "tunnel",
  type: "tailscale",
  metadata: {
    author: "Kiln",
    id: "tailscale",
    name: "Tailscale",
    summary: "Reach what runs on a Relay by name.",
  },
  deploy: { type: "image", image: "tailscale/tailscale:stable" },
  tunnel: { dns: { image: "coredns/coredns:1.14.7" } },
}

const recipe = (change: Record<string, unknown> = {}) =>
  brickRecipeSchema.parse({ ...tailscale, ...change })

describe("A tunnel Brick", () => {
  it("runs the images it pins", () => {
    expect(tunnelBrickImages(recipe())).toEqual({
      dns: "coredns/coredns:1.14.7",
      tailscale: "tailscale/tailscale:stable",
    })
  })

  it("is a tunnel, and only a tunnel has its section", () => {
    expect(
      brickRecipeSchema.safeParse({ ...tailscale, tunnel: undefined }).success
    ).toBe(false)
    expect(
      brickRecipeSchema.safeParse({
        ...tailscale,
        kind: "app",
        type: undefined,
      }).success
    ).toBe(false)
  })

  // Kiln makes the rest of both containers for these images: its login,
  // routes, firewall and DNS rely on them.
  it("refuses another image, another type, or anything Kiln makes itself", () => {
    expect(
      tunnelBrickProblem(
        recipe({ deploy: { type: "image", image: "example/tailscale:stable" } })
      )
    ).toMatch(/tailscale\/tailscale image/u)
    expect(
      tunnelBrickProblem(
        recipe({ tunnel: { dns: { image: "coredns/coredns@sha256:abc" } } })
      )
    ).toMatch(/coredns\/coredns image/u)
    expect(
      tunnelBrickProblem(
        recipe({
          deploy: {
            type: "image",
            image: "tailscale/tailscale:stable",
            env: { TS_EXTRA_ARGS: "--advertise-exit-node" },
          },
        })
      )
    ).toMatch(/can't set env/u)
    expect(
      tunnelBrickProblem(
        recipe({
          inputs: [{ key: "tag", label: "Tag", type: "text" }],
        })
      )
    ).toMatch(/asks nothing/u)
    expect(
      brickRecipeSchema.safeParse({ ...tailscale, type: "wireguard" }).success
    ).toBe(false)
  })
})
