import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vite-plus/test"
import { brickRecipeSchema } from "@workspace/contracts"

import { BrickRecipeError } from "./effect/errors.js"
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

  it("resolves a valid recipe-relative icon URL", () => {
    expect(
      resolveRecipeIconSource(
        {
          ...recipe,
          metadata: { ...recipe.metadata, icon: "../icons/example.svg" },
        },
        new URL("https://example.com/recipes/example.yml"),
        false
      ).metadata.icon
    ).toBe("https://example.com/icons/example.svg")
  })

  it("resolves defaults, overrides, resources, and literal templates", () => {
    const resolved = resolveBrick(recipe, { memory: "4G" })
    expect(resolved.values).toEqual({
      version: "1.2.3",
      memory: "4G",
      debug: false,
      java_version: "21",
    })
    expect(resolved.environment).toEqual({
      VERSION: "1.2.3",
      DEBUG: "false",
      BRICK: "example",
    })
    expect(resolved.memory).toBe("4G")
    expect(resolved.image).toBe("registry.example.com/custom/server:21")
    expect(resolved.runtimeName).toBe("Java 21")
    const java25 = resolveBrick(recipe, {
      java_version: "25",
      memory: "4G",
    })
    expect(java25.image).toBe("registry.example.com/custom/server:25")
    expect(java25.runtimeName).toBe("Java 25")
  })

  it("derives the Java Ember from Minecraft unless explicitly overridden", () => {
    const paper = brickRecipeSchema.parse({
      ...recipe,
      metadata: { ...recipe.metadata, game: "Minecraft", id: "paper" },
      variables: {
        ...recipe.variables,
        version: { ...recipe.variables.version, default: "1.21.11" },
        java_version: {
          ...recipe.variables.java_version,
          options: undefined,
          rules: { pattern: "^(?:11|17|21|25)$" },
        },
      },
    })

    expect(resolveBrick(paper, { version: "26.2" }).values.java_version).toBe(
      "25"
    )
    expect(
      resolveBrick(paper, { java_version: "21", version: "26.2" }).values
        .java_version
    ).toBe("21")
    expect(() => resolveBrick(paper, { version: "1.16.5" })).toThrow(
      /requires Java 16/u
    )
  })

  it("rejects undeclared and invalid variable values", () => {
    expect(() => resolveBrick(recipe, { unknown: "value" })).toThrow(
      BrickRecipeError
    )
    expect(() => resolveBrick(recipe, { memory: "8G" })).toThrow(
      /declared options/u
    )
    expect(() => resolveBrick(recipe, { version: "latest" })).toThrow(
      /recipe rule/u
    )
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

  it.each([
    "https://127.0.0.1/recipe.yml",
    "https://10.42.0.1/recipe.yml",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/recipe.yml",
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

  it("keeps legacy file-backed catalog recipes readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kiln-brick-catalog-"))
    try {
      const catalogPath = join(directory, "catalog.yml")
      const recipePath = join(directory, "recipe.yml")
      await Promise.all([
        writeFile(
          catalogPath,
          "format: kiln.catalog/v1\nrecipes: [recipe.yml]\n"
        ),
        writeFile(recipePath, JSON.stringify(recipe)),
      ])
      const catalog = new BrickCatalog(
        pathToFileURL(catalogPath).href,
        join(directory, "data")
      )

      await expect(
        catalog.recipe(pathToFileURL(recipePath).href)
      ).resolves.toEqual(recipe)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("preserves a Brick id beyond the recommended length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kiln-brick-import-"))
    try {
      const catalogPath = join(directory, "catalog.yml")
      const recipePath = join(directory, "recipe.yml")
      await Promise.all([
        writeFile(
          catalogPath,
          "format: kiln.catalog/v1\nrecipes: [recipe.yml]\n"
        ),
        writeFile(
          recipePath,
          JSON.stringify({
            ...recipe,
            metadata: {
              ...recipe.metadata,
              id: "abcdefghijklmnopqrst-extra",
            },
          })
        ),
      ])
      const catalog = new BrickCatalog(
        pathToFileURL(catalogPath).href,
        join(directory, "data")
      )

      const imported = await catalog.recipe(pathToFileURL(recipePath).href)

      expect(imported.metadata.id).toBe("abcdefghijklmnopqrst-extra")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
