import { describe, expect, it } from "vite-plus/test"

import {
  appBrickDeploy,
  appBrickProblem,
  brickInstallAnswers,
} from "./app-bricks"
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
      deploy: {
        environment: {},
        image: "ghcr.io/acme/site:latest",
        type: "image",
      },
    })
    expect(
      appBrickDeploy(image, { name: "ghcr.io/acme/site", tag: "2" })
    ).toEqual({
      deploy: { environment: {}, image: "ghcr.io/acme/site:2", type: "image" },
    })
  })

  it("sets the variables its answers make, a secret Kiln made among them", () => {
    const keyed = recipe({
      inputs: [
        { key: "mode", label: "Mode", type: "text", default: "production" },
        { key: "key", label: "Key", type: "secret", generate: true },
      ],
      deploy: {
        type: "image",
        image: "nginx:1",
        env: { MODE: "{{ mode }}", SECRET_KEY: "{{ key }}" },
      },
    })
    // Kept as they stand at install, a default among them, and a secret
    // made once: one given, as when it is installed again, is kept.
    const made = brickInstallAnswers(keyed, {}, () => "made-once")
    expect(made).toEqual({ key: "made-once", mode: "production" })
    expect(brickInstallAnswers(keyed, made, () => "another")).toEqual(made)
    expect(appBrickDeploy(keyed, made)).toEqual({
      deploy: {
        environment: { MODE: "production", SECRET_KEY: "made-once" },
        image: "nginx:1",
        type: "image",
      },
    })
    // Never deployed with the secret's template left in its place.
    expect(appBrickDeploy(keyed, {})).toEqual({
      problem: "SECRET_KEY needs an answer this Brick wasn't given",
    })
    expect(appBrickDeploy(keyed, { ...made, mode: "a\nADMIN=1" })).toEqual({
      problem: "MODE can't hold a line break",
    })
  })

  it("says where its website answers, and only that of its ports", () => {
    const served = (ports: Array<unknown>, inputs: Array<unknown> = []) =>
      recipe({ inputs, deploy: { type: "image", image: "nginx:1", ports } })
    expect(
      appBrickDeploy(served([{ name: "web", port: 3000 }]), {})
    ).toMatchObject({ deploy: { web: { port: 3000 } } })
    // An input can answer it. Left blank, the App has no website to route.
    const asked = served(
      [{ name: "web", port: "{{ port }}" }],
      [{ key: "port", label: "Web port", type: "number", optional: true }]
    )
    expect(appBrickDeploy(asked, { port: 8080 })).toMatchObject({
      deploy: { web: { port: 8080 } },
    })
    expect(appBrickDeploy(asked, {})).toEqual({
      deploy: { environment: {}, image: "nginx:1", type: "image" },
    })
    expect(appBrickDeploy(asked, { port: 70_000 })).toEqual({
      problem: "This Brick's web port isn't a port",
    })
    // A Compose project's is one service's.
    const stack = (port: object) =>
      recipe({
        deploy: { type: "compose", path: "compose.yaml", ports: [port] },
      })
    expect(
      appBrickDeploy(stack({ name: "web", port: 80, service: "site" }), {})
    ).toEqual({
      deploy: {
        path: "compose.yaml",
        type: "compose",
        web: { port: 80, service: "site" },
      },
    })
    expect(appBrickProblem(stack({ name: "web", port: 80 }))).toBe(
      "A Compose project's web port names its service"
    )
    // A port published on the host, or a second one, isn't run yet.
    expect(
      appBrickProblem(served([{ name: "game", port: 25565, expose: "public" }]))
    ).toBe("Kiln only routes an App Brick's web port for now")
    expect(
      appBrickProblem(
        served([
          { name: "web", port: 80 },
          { name: "admin", port: 8080 },
        ])
      )
    ).toBe("Kiln gives an App Brick one web port for now")
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
          deploy: { type: "image", image: "nginx:1", volumes: ["/data"] },
        })
      )
    ).toBe("Kiln doesn't run an App Brick's volumes yet")
    expect(
      appBrickProblem(
        recipe({ deploy: { type: "dockerfile", dockerfile: "FROM nginx:1" } })
      )
    ).toBe("Kiln doesn't run an App Brick's dockerfile yet")
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
