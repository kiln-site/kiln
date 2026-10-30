import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vite-plus/test"
import { brickRecipeSchema } from "@workspace/contracts"

import {
  BrickCatalog,
  resolveRecipeIconSource,
  resolveBrick,
} from "./bricks.js"
import type { BrickRecipe } from "@workspace/contracts"

const recipe: BrickRecipe = brickRecipeSchema.parse({
  format: "kiln.brick/v1",
  metadata: {
    id: "example",
    name: "Example",
    description: "A test Brick recipe.",
    game: "Example Game",
    author: "Kiln",
  },
  variables: {
    version: {
      type: "string",
      label: "Version",
      description: "Release to install.",
      required: true,
      default: "1.2.3",
      rules: { pattern: "^[0-9.]+$" },
    },
    memory: {
      type: "string",
      label: "Memory",
      description: "Memory allocation.",
      required: true,
      default: "2G",
      options: ["2G", "4G"],
    },
    debug: {
      type: "boolean",
      label: "Debug",
      description: "Enable debug output.",
      required: false,
      default: false,
    },
    java_version: {
      type: "string",
      label: "Java version",
      description: "JDK release used to run the server.",
      required: true,
      default: "21",
      options: ["11", "17", "21", "25"],
    },
  },
  runtime: {
    image: "registry.example.com/custom/server:{{ variables.java_version }}",
    name: "Java {{ variables.java_version }}",
    environment: {
      VERSION: "{{ variables.version }}",
      DEBUG: "{{ variables.debug }}",
      BRICK: "{{ brick.id }}",
    },
    resources: {
      memory: "{{ variables.memory }}",
      memoryReservation: "{{ variables.memory }}",
      pids: 128,
    },
    storage: { mount: "/server" },
  },
  network: {
    mode: "direct",
    primaryPort: "game",
    hostname: "{{ brick.id }}",
    ports: [{ name: "game", container: 7777, protocol: "udp" }],
  },
  readiness: {
    logs: [" Server ready "],
  },
  console: {
    stopCommands: [" stop ", "/stop"],
  },
})

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

  it("rejects expressions because templates are not executable", () => {
    const executable = brickRecipeSchema.parse({
      ...recipe,
      runtime: {
        ...recipe.runtime,
        environment: { VERSION: "{{ variables.version.toString() }}" },
      },
    })

    expect(() => resolveBrick(executable, {})).toThrow(
      expect.objectContaining({ code: "invalid_template" })
    )
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
