import { describe, expect, it } from "vite-plus/test"

import { appBrickDeploy, appBrickProblem } from "./app-bricks"
import { brickRecipeSchema } from "./brick-recipe"

const metadata = {
  id: "example",
  name: "Example",
  summary: "An example.",
  author: "Kiln",
}

const recipe = (parts: Record<string, unknown>) =>
  brickRecipeSchema.parse({
    format: "kiln.brick/v2",
    kind: "app",
    metadata,
    ...parts,
  })

const image = recipe({
  inputs: [
    { key: "name", label: "Image", type: "text" },
    { key: "tag", label: "Tag", type: "text", default: "latest" },
  ],
  deploy: { type: "image", image: "{{ name }}:{{ tag }}" },
})

describe("an App Brick", () => {
  it("deploys the image its answers make, a default standing in for one not given", () => {
    expect(appBrickDeploy(image, { name: "ghcr.io/acme/site" })).toEqual({
      deploy: { image: "ghcr.io/acme/site:latest", type: "image" },
    })
    expect(
      appBrickDeploy(image, { name: "ghcr.io/acme/site", tag: "2" })
    ).toEqual({ deploy: { image: "ghcr.io/acme/site:2", type: "image" } })
  })

  it("deploys the file at its path in whatever source it is given", () => {
    expect(
      appBrickDeploy(
        recipe({ deploy: { type: "compose", path: "deploy/compose.yaml" } }),
        {}
      )
    ).toEqual({ deploy: { path: "deploy/compose.yaml", type: "compose" } })
  })

  it("refuses answers it can't deploy from", () => {
    expect(appBrickDeploy(image, {})).toEqual({
      problem: "Image is required",
    })
    expect(appBrickDeploy(image, { name: 3 })).toEqual({
      problem: "Image must be text",
    })
    expect(appBrickDeploy(image, { name: "nginx", command: "sh" })).toEqual({
      problem: "This Brick doesn't ask for command",
    })
  })

  it("is refused while it uses a part Kiln doesn't run for an App", () => {
    expect(appBrickProblem(image)).toBeNull()
    expect(
      appBrickProblem(
        recipe({
          deploy: {
            type: "image",
            image: "nginx:1",
            env: { MODE: "production" },
          },
        })
      )
    ).toBe("Kiln doesn't run an App Brick's env yet")
    expect(
      appBrickProblem(
        recipe({ deploy: { type: "dockerfile", dockerfile: "FROM nginx:1" } })
      )
    ).toBe("Kiln doesn't run an App Brick's dockerfile yet")
    expect(
      appBrickProblem(
        recipe({
          inputs: [
            { key: "key", label: "Key", type: "secret", generate: true },
          ],
          deploy: { type: "image", image: "nginx:1" },
        })
      )
    ).toBe("Kiln doesn't make an App Brick's secrets yet (Key)")
    // Another kind's Brick is no App's, whatever it deploys.
    expect(
      appBrickProblem(
        brickRecipeSchema.parse({
          format: "kiln.brick/v2",
          kind: "game-server",
          metadata,
          deploy: {
            type: "image",
            image: "nginx:1",
            ports: [{ name: "game", port: 25565 }],
          },
        })
      )
    ).toBe("This isn't an App Brick")
  })
})
