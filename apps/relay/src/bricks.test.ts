import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vite-plus/test"
import { brickRecipeSchema } from "@workspace/contracts"

import {
  BrickCatalog,
  resolveDatabaseBrick,
  resolveRecipeIconSource,
  resolveBrick,
} from "./bricks.js"
import type { BrickRecipe } from "@workspace/contracts"

import { provisioningErrorMessage } from "./provisioning-errors.js"

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

// What Kiln gives a database, which its Brick's templates take.
const login = {
  host: "database-dddddddddddd",
  name: "kiln_app",
  password: "correct-horse-battery-staple-1",
  username: "kiln_user",
}
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
  it("names a source it couldn't load without the credentials in it", async () => {
    const catalog = new BrickCatalog(
      "https://catalog.example/catalog.yml",
      join(tmpdir(), "kiln-unused-brick-data")
    )
    // A private address, so it is refused before anything is fetched.
    const failure = await catalog
      .recipe("https://token:hunter2@127.0.0.1/private.yml?key=signed#part")
      .then(
        () => null,
        (cause: unknown) => cause
      )

    // What whoever asked is told, and what the deployment's log keeps.
    for (const told of [
      (failure as Error).message,
      provisioningErrorMessage(failure),
    ]) {
      expect(told).toContain("127.0.0.1/private.yml")
      expect(told).not.toContain("hunter2")
      expect(told).not.toContain("signed")
    }
  })

  it("load, and resolve with nothing answered", async () => {
    const { bricks } = await catalogAt("bricks.yml").catalog()
    const ids = (kind: string) =>
      bricks
        .filter((brick) => brick.kind === kind)
        .map((brick) => brick.metadata.id)
        .sort()
    expect(ids("game-server")).toEqual([
      "fabric",
      "folia",
      "palworld",
      "paper",
      "velocity",
    ])
    expect(ids("database")).toEqual([
      "mariadb",
      "mysql",
      "postgres",
      "redis",
      "valkey",
    ])
    for (const brick of bricks) {
      const { source: _source, ...definition } = brick
      if (definition.kind === "database") {
        expect(() =>
          resolveDatabaseBrick(definition, {}, login)
        ).not.toThrow()
      } else {
        expect(() => resolveBrick(definition, {})).not.toThrow()
      }
    }
  })

  // The engine table these replaced: a database made from a Brick has to
  // run as one made before did.
  it.each([
    ["postgres", "postgres:17", "/var/lib/postgresql/data", 5432],
    ["mysql", "mysql:8.4", "/var/lib/mysql", 3306],
    ["mariadb", "mariadb:11.8", "/var/lib/mysql", 3306],
    ["redis", "redis:8", "/data", 6379],
    ["valkey", "valkey/valkey:8", "/data", 6379],
  ])(
    "run a %s database as Kiln ran one before it had a Brick",
    async (id, image, dataMount, internalPort) => {
      const { bricks } = await catalogAt("bricks.yml").catalog()
      const { source: _source, ...definition } = bricks.find(
        (brick) => brick.metadata.id === id
      )!
      const resolved = resolveDatabaseBrick(definition, {}, login)

      expect(resolved).toMatchObject({
        dataMount,
        engine: id,
        image,
        internalPort,
      })
      // Its login is the one Kiln gives it, never an answer.
      const environment = JSON.stringify(resolved.environment)
      if (id !== "redis" && id !== "valkey") {
        expect(environment).toContain(login.username)
        expect(environment).toContain(login.password)
        expect(environment).toContain(login.name)
      }
      expect(environment).not.toContain("{{")
    }
  )

  // Kiln logs in to, rotates, dumps and browses a type through its own
  // image's tools, on the port they reach, so a Brick from any catalog
  // can't run something else under that type.
  it("refuse a database that doesn't run as its type does", async () => {
    const { bricks } = await catalogAt("bricks.yml").catalog()
    const { source: _source, ...postgres } = bricks.find(
      (brick) => brick.metadata.id === "postgres"
    )!
    const deploy = postgres.deploy
    if (deploy?.type !== "image") throw new Error("Not an image")
    const withImage = (image: string, inputs = postgres.inputs) => ({
      ...postgres,
      deploy: { ...deploy, image },
      inputs,
    })

    expect(() =>
      resolveDatabaseBrick(withImage("example.com/other/postgres:17"), {}, login)
    ).toThrow(/runs from the postgres image/u)
    // An answer that would turn the tag into another registry's image.
    const freeVersion = withImage("postgres:{{ version }}", [
      { key: "version", label: "Version", type: "text", default: "17" },
    ])
    expect(resolveDatabaseBrick(freeVersion, {}, login).image).toBe(
      "postgres:17"
    )
    for (const version of ["5000/evil", "17@sha256:abc", "17/evil:1"]) {
      expect(() =>
        resolveDatabaseBrick(freeVersion, { version }, login)
      ).toThrow(/runs from the postgres image/u)
    }

    // Rotation and wipes reach Redis where its tools look for it, and log
    // in with the users file Kiln writes.
    const { source: _redisSource, ...redis } = bricks.find(
      (brick) => brick.metadata.id === "redis"
    )!
    const redisDeploy = redis.deploy
    if (redisDeploy?.type !== "image") throw new Error("Not an image")
    expect(() =>
      resolveDatabaseBrick(
        {
          ...redis,
          deploy: { ...redisDeploy, ports: [{ name: "redis", port: 6380 }] },
        },
        {},
        login
      )
    ).toThrow(/listens on port 6379/u)
    expect(() =>
      resolveDatabaseBrick(
        {
          ...redis,
          deploy: { ...redisDeploy, command: ["redis-server"] },
        },
        {},
        login
      )
    ).toThrow(/--aclfile/u)

    // MariaDB's image takes MYSQL_* names too, and would start. Kiln's
    // dumps and wipes read the MARIADB_* ones back inside the container.
    const { source: _mariadbSource, ...mariadb } = bricks.find(
      (brick) => brick.metadata.id === "mariadb"
    )!
    const mariadbDeploy = mariadb.deploy
    if (mariadbDeploy?.type !== "image") throw new Error("Not an image")
    expect(() =>
      resolveDatabaseBrick(
        {
          ...mariadb,
          deploy: {
            ...mariadbDeploy,
            env: Object.fromEntries(
              Object.entries(mariadbDeploy.env ?? {}).map(([name, value]) => [
                name.replace("MARIADB_", "MYSQL_"),
                value,
              ])
            ),
          },
        },
        {},
        login
      )
    ).toThrow(/sets MARIADB_DATABASE/u)
    // A root password written into the recipe is one anyone can read.
    expect(() =>
      resolveDatabaseBrick(
        {
          ...mariadb,
          deploy: {
            ...mariadbDeploy,
            env: { ...mariadbDeploy.env, MARIADB_ROOT_PASSWORD: "hunter2" },
          },
        },
        {},
        login
      )
    ).toThrow(/MARIADB_ROOT_PASSWORD to a secret Kiln generates/u)
    // Nor is a generated secret that comes with a value of its own, which
    // would be used in place of one Kiln makes.
    expect(() =>
      resolveDatabaseBrick(
        {
          ...mariadb,
          inputs: mariadb.inputs?.map((input) =>
            input.key === "root_password"
              ? { ...input, default: "hunter2" }
              : input
          ),
        },
        {},
        login
      )
    ).toThrow(/MARIADB_ROOT_PASSWORD to a secret Kiln generates/u)
  })

  // Servers made from the v1 recipes keep those recipes. Read now, each has
  // to run what its v2 Brick runs.
  it("run the same thing read from their kiln.brick/v1 recipes", async () => {
    const [v1, v2] = await Promise.all([
      catalogAt("catalog.yml").catalog(),
      catalogAt("bricks.yml").catalog(),
    ])
    // Only game servers had v1 recipes.
    const servers = v2.bricks.filter((brick) => brick.kind === "game-server")
    expect(v1.bricks).toHaveLength(servers.length)
    for (const brick of servers) {
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
