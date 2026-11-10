import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vite-plus/test"
import { brickRecipeSchema } from "@workspace/contracts"

import {
  BrickCatalog,
  resolveRecipeIconSource,
  resolveBrick,
} from "./bricks.js"
import type { BrickRecipe } from "@workspace/contracts"

const recipe: BrickRecipe = brickRecipeSchema.parse({
  format: "kiln.brick/v2",
  kind: "game-server",
  metadata: {
    id: "example",
    name: "Example",
    summary: "A test Brick recipe.",
    author: "Kiln",
  },
  inputs: [
    {
      key: "version",
      label: "Version",
      type: "text",
      default: "1.2.3",
      pattern: "^[0-9.]+$",
    },
    {
      key: "java_version",
      label: "Java version",
      type: "select",
      options: ["17", "21"],
      default: "21",
      suggest: [
        { when: "version", from: "2", value: "25" },
        { when: "version", below: "1", value: "17" },
      ],
    },
    { key: "token", label: "Token", type: "secret", generate: true },
  ],
  deploy: {
    type: "image",
    image: "registry.example.com/custom/server:{{ java_version }}",
    runtime: "Java {{ java_version }}",
    env: {
      VERSION: "{{ version }}",
      TOKEN: "{{ token }}",
      BRICK: "{{ brick.id }}",
    },
    memory: "2G",
    volumes: ["/server"],
    ports: [{ name: "game", port: 7777, protocol: "udp" }],
  },
})

const bricksDirectory = resolve(import.meta.dirname, "../../bricks")
const catalogAt = (file: string) =>
  new BrickCatalog(
    pathToFileURL(join(bricksDirectory, file)).href,
    join(tmpdir(), "kiln-unused-brick-data")
  )

describe("Brick recipes", () => {
  it.each([
    "http://example.com/icon.svg",
    "data:image/svg+xml,<svg></svg>",
    "file:///tmp/icon.svg",
    "https://[",
  ])("ignores an unusable optional icon URL: %s", (icon) => {
    const resolved = resolveRecipeIconSource(
      { ...recipe, metadata: { ...recipe.metadata, icon } },
      new URL("https://example.com/recipe.yml"),
      false
    )

    expect(resolved.metadata.icon).toBeUndefined()
    expect(resolved.metadata.id).toBe(recipe.metadata.id)
  })

  it("lets a default follow another answer, unless one was given", () => {
    expect(resolveBrick(recipe, {}).image).toBe(
      "registry.example.com/custom/server:21"
    )
    expect(resolveBrick(recipe, { version: "0.9" }).values.java_version).toBe(
      "17"
    )
    expect(
      resolveBrick(recipe, { version: "0.9", java_version: "21" }).values
        .java_version
    ).toBe("21")
    // What a rule asks for has to be something the Brick offers.
    expect(() => resolveBrick(recipe, { version: "2.0" })).toThrow(
      expect.objectContaining({ code: "unsupported_suggestion" })
    )
  })

  it("takes a required input's only value from what it follows", () => {
    const { default: _default, ...java } = recipe.inputs![1]!
    const followed = brickRecipeSchema.parse({
      ...recipe,
      inputs: [recipe.inputs![0], java, recipe.inputs![2]],
    })
    expect(resolveBrick(followed, { version: "0.9" }).values.java_version).toBe(
      "17"
    )
    // Nothing follows 1.2.3, and it has no default left to fall back on.
    expect(() => resolveBrick(followed, {})).toThrow(
      expect.objectContaining({ code: "missing_variable" })
    )
  })

  it("refuses an answer its input doesn't allow, or names no input", () => {
    expect(() => resolveBrick(recipe, { version: "1; rm -rf /" })).toThrow(
      expect.objectContaining({ code: "invalid_variable" })
    )
    expect(() => resolveBrick(recipe, { java_version: "8" })).toThrow(
      expect.objectContaining({ code: "invalid_variable" })
    )
    expect(() => resolveBrick(recipe, { command: "sh" })).toThrow(
      expect.objectContaining({ code: "unknown_variable" })
    )
  })

  it("makes a secret nobody gave, and keeps one that was", () => {
    const made = resolveBrick(recipe, {}).values.token
    expect(String(made).length).toBeGreaterThanOrEqual(32)
    expect(resolveBrick(recipe, {}).values.token).not.toBe(made)
    expect(resolveBrick(recipe, { token: "given" }).environment.TOKEN).toBe(
      "given"
    )
  })

  it("refuses kinds and parts it doesn't run yet, by name", () => {
    expect(() =>
      resolveBrick(
        brickRecipeSchema.parse({
          ...recipe,
          deploy: {
            ...recipe.deploy,
            volumes: ["/server", "/mods"],
          },
        }),
        {}
      )
    ).toThrow(expect.objectContaining({ code: "unsupported_brick" }))
    expect(() =>
      resolveBrick(
        brickRecipeSchema.parse({
          ...recipe,
          kind: "app",
        }),
        {}
      )
    ).toThrow(expect.objectContaining({ code: "unsupported_brick" }))
  })

  // The full address list lives in source-policy.test.ts; these prove the
  // catalog applies it to IPv6 literals and to resolved hostnames.
  it.each([
    "https://[::ffff:7f00:1]/recipe.yml",
    "https://localhost/recipe.yml",
  ])("refuses to fetch a recipe from private address %s", async (source) => {
    const catalog = new BrickCatalog(
      "https://catalog.example/catalog.yml",
      join(tmpdir(), "kiln-unused-brick-data")
    )

    await expect(catalog.recipe(source)).rejects.toMatchObject({
      code: "blocked_recipe_address",
    })
  })
})

describe("the official Bricks", () => {
  it("load, and resolve with nothing answered", async () => {
    const { bricks } = await catalogAt("bricks.yml").catalog()
    expect(bricks.map((brick) => brick.metadata.id).sort()).toEqual([
      "fabric",
      "folia",
      "palworld",
      "paper",
      "velocity",
    ])
    for (const brick of bricks) {
      const { source: _source, ...definition } = brick
      expect(() => resolveBrick(definition, {})).not.toThrow()
    }
  })

  // Servers made from the v1 recipes keep those recipes. Read now, each has
  // to run what its v2 Brick runs.
  it("run the same thing read from their kiln.brick/v1 recipes", async () => {
    const [v1, v2] = await Promise.all([
      catalogAt("catalog.yml").catalog(),
      catalogAt("bricks.yml").catalog(),
    ])
    expect(v1.bricks).toHaveLength(v2.bricks.length)
    for (const brick of v2.bricks) {
      const stored = v1.bricks.find(
        (candidate) => candidate.metadata.id === brick.metadata.id
      )!
      const { source: _v2Source, ...current } = brick
      const { source: _v1Source, ...converted } = stored
      const now = resolveBrick(current, {})
      const before = resolveBrick(converted, {})
      // v1 asked for memory as a variable; v2 writes the limit itself.
      const { memory: _memory, ...values } = before.values
      expect({ ...before, recipe: null, values }, brick.metadata.id).toEqual({
        ...now,
        recipe: null,
      })
    }
  })
})
