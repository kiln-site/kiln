import { describe, expect, it } from "vite-plus/test"

import {
  brickRecipeFromV1,
  readBrick,
  readBrickRecipe,
} from "./brick-conversion"
import { readRelayCatalog } from "./index"
import { brickInputProblem, brickSuggestedValue } from "./brick-recipe"
import { brickRecipeV1Schema, type BrickRecipeV1 } from "./brick-v1"

// A v1 recipe as a Relay or Hearth stored one, using every part of the
// format.
const v1 = {
  format: "kiln.brick/v1",
  metadata: {
    id: "paper",
    name: "Paper",
    description: "Fast Minecraft server.",
    game: "Minecraft",
    author: "Kiln",
    icon: "https://example.test/paper.svg",
    color: "#e67e7e",
    documentation: "https://example.test/docs",
    tags: ["minecraft", "java"],
  },
  variables: {
    version: {
      type: "string",
      label: "Minecraft version",
      description: "Release to install.",
      required: true,
      default: "26.2",
      rules: { pattern: "^[0-9.]+$", maxLength: 32 },
    },
    memory: {
      type: "string",
      label: "Memory",
      description: "Container memory.",
      required: true,
      default: "2G",
    },
    java_version: {
      type: "string",
      label: "Java version",
      description: "JDK to run on.",
      required: true,
      default: "21",
      rules: { pattern: "^(?:11|17|21|25)$" },
    },
    mode: {
      type: "string",
      label: "Mode",
      description: "Game mode.",
      required: false,
      options: ["survival", "creative"],
      default: "survival",
    },
    players: {
      type: "number",
      label: "Players",
      description: "Most players at once.",
      required: true,
      default: 20,
      rules: { min: 1, max: 100 },
    },
    token: {
      type: "string",
      label: "Token",
      description: "A secret.",
      required: false,
      sensitive: true,
      rules: { minLength: 8 },
    },
    whitelist: {
      type: "boolean",
      label: "Whitelist",
      description: "Only listed players.",
      required: true,
      default: false,
    },
  },
  runtime: {
    image: "ghcr.io/kiln-site/bricks-java:{{ variables.java_version }}",
    name: "Java {{variables.java_version}}",
    environment: {
      KILN_VERSION: "{{ variables.version }}",
      KILN_BRICK: "{{ brick.id }}",
    },
    entrypoint: ["/entrypoint.sh"],
    command: ["--nogui"],
    workingDirectory: "/server",
    stopSignal: "SIGINT",
    user: "1000:1000",
    resources: {
      memory: "{{ variables.memory }}",
      memoryReservation: "{{ variables.memory }}",
      pids: 1024,
    },
    storage: { mount: "/server" },
  },
  readiness: { logs: ["Done ("] },
  console: { stopCommands: ["stop", "/stop"] },
  network: {
    mode: "minecraft-backend",
    primaryPort: "game",
    supportsSrv: true,
    hostname: "{{ variables.version }}.{{ brick.id }}",
    ports: [
      { name: "query", container: 25575, protocol: "udp", host: 25575 },
      { name: "game", container: 25565, protocol: "tcp" },
    ],
  },
  constraints: { architectures: ["amd64", "arm64"] },
}

const stored = (changes: (recipe: typeof v1) => unknown = (recipe) => recipe) =>
  brickRecipeV1Schema.parse(changes(structuredClone(v1))) as BrickRecipeV1

describe("a kiln.brick/v1 recipe read as v2", () => {
  it("runs what it ran before", () => {
    const converted = brickRecipeFromV1(stored())
    expect(converted).toEqual({
      format: "kiln.brick/v2",
      kind: "game-server",
      type: "minecraft",
      metadata: {
        id: "paper",
        name: "Paper",
        summary: "Fast Minecraft server.",
        author: "Kiln",
        icon: "https://example.test/paper.svg",
        color: "#e67e7e",
        tags: ["minecraft", "java"],
        links: { docs: "https://example.test/docs" },
        platforms: ["amd64", "arm64"],
      },
      inputs: [
        {
          key: "version",
          label: "Minecraft version",
          help: "Release to install.",
          type: "text",
          default: "26.2",
          pattern: "^[0-9.]+$",
          max: 32,
        },
        {
          key: "memory",
          label: "Memory",
          help: "Container memory.",
          type: "text",
          default: "2G",
        },
        expect.objectContaining({
          key: "java_version",
          type: "text",
          default: "21",
          pattern: "^(?:11|17|21|25)$",
        }),
        {
          key: "mode",
          label: "Mode",
          help: "Game mode.",
          optional: true,
          type: "select",
          options: ["survival", "creative"],
          default: "survival",
        },
        {
          key: "players",
          label: "Players",
          help: "Most players at once.",
          type: "number",
          default: 20,
          min: 1,
          max: 100,
        },
        {
          key: "token",
          label: "Token",
          help: "A secret.",
          optional: true,
          type: "secret",
          min: 8,
        },
        {
          key: "whitelist",
          label: "Whitelist",
          help: "Only listed players.",
          type: "boolean",
          default: false,
        },
      ],
      deploy: {
        type: "image",
        image: "ghcr.io/kiln-site/bricks-java:{{ java_version }}",
        runtime: "Java {{ java_version }}",
        user: "1000:1000",
        entrypoint: ["/entrypoint.sh"],
        command: ["--nogui"],
        workingDirectory: "/server",
        stopSignal: "SIGINT",
        env: {
          KILN_VERSION: "{{ version }}",
          KILN_BRICK: "{{ brick.id }}",
        },
        // Still its variable's answer, as the instances made from it hold.
        memory: "{{ memory }}",
        pids: 1024,
        volumes: ["/server"],
        // The primary port comes first.
        ports: [
          { name: "game", port: 25565 },
          { name: "query", port: 25575, protocol: "udp", host: 25575 },
        ],
        ready: { log: ["Done ("] },
      },
      "game-server": {
        game: "Minecraft",
        stop: ["stop", "/stop"],
        srv: true,
      },
      // Kiln completed commands in Paper's console by its ID.
      minecraft: { completion: true },
    })
  })

  it("keeps a game that reaches players directly without a type", () => {
    const converted = brickRecipeFromV1(
      stored((recipe) => ({
        ...recipe,
        network: { ...recipe.network, mode: "direct", supportsSrv: false },
      }))
    )
    expect(converted.type).toBeUndefined()
    expect(converted["game-server"]).toEqual({
      game: "Minecraft",
      stop: ["stop", "/stop"],
    })
  })

  // Kiln chose these by Brick ID; a converted recipe carries them itself.
  it.each([
    ["paper", "26.2", "25"],
    ["paper", "1.21.4", "21"],
    ["paper", "1.20", "21"],
    ["paper", "1.19.4", "17"],
    ["paper", "1.16.5", "16"],
    ["paper", "1.16.4", "11"],
    ["paper", "1.8.8", "8"],
    ["paper", "26.0", undefined],
    ["folia", "1.21", "21"],
    ["fabric", "1.20.5", "21"],
    ["fabric", "1.20.4", "17"],
    ["fabric", "1.16.5", "8"],
    ["velocity", "4.1.2-SNAPSHOT", "25"],
    ["velocity", "3.5.0", "21"],
    ["velocity", "3.4.0-SNAPSHOT", "17"],
    ["velocity", "3.1.0", "11"],
    ["palworld", "1.21", undefined],
  ])("suggests the Java %s %s needs", (id, version, java) => {
    const converted = brickRecipeFromV1(
      stored((recipe) => ({
        ...recipe,
        metadata: { ...recipe.metadata, id },
      }))
    )
    const input = converted.inputs!.find((item) => item.key === "java_version")!
    expect(brickSuggestedValue(input, { version })).toBe(java)
  })

  // v1 checked an answer against its options and then against its rules.
  it("refuses every answer the v1 variable refused", () => {
    const variable = (definition: Record<string, unknown>) => ({
      label: "Value",
      description: "A value.",
      required: true,
      ...definition,
    })
    const converted = brickRecipeFromV1(
      stored((recipe) => ({
        ...recipe,
        variables: {
          channel: variable({
            type: "string",
            options: ["safe", "unsafe"],
            rules: { pattern: "^safe$" },
          }),
          slots: variable({
            type: "number",
            options: [1, 5, 50],
            rules: { max: 10 },
          }),
          eula: variable({ type: "boolean", options: [true] }),
          name: variable({
            type: "string",
            rules: { minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
          }),
        },
        runtime: {
          ...recipe.runtime,
          image: "example:{{ variables.channel }}",
          name: "Example",
          environment: {},
          resources: { memory: "1G" },
        },
        network: { ...recipe.network, hostname: undefined },
      }))
    )
    const problem = (key: string, value: string | number | boolean) =>
      brickInputProblem(
        converted.inputs!.find((input) => input.key === key)!,
        value
      )
    expect(problem("channel", "safe")).toBeNull()
    expect(problem("channel", "unsafe")).not.toBeNull()
    expect(problem("channel", "other")).not.toBeNull()
    expect(problem("slots", 5)).toBeNull()
    expect(problem("slots", 50)).not.toBeNull()
    expect(problem("slots", 2)).not.toBeNull()
    expect(problem("eula", true)).toBeNull()
    expect(problem("eula", false)).not.toBeNull()
    expect(problem("name", "abc")).toBeNull()
    expect(problem("name", "a")).not.toBeNull()
    expect(problem("name", "abcde")).not.toBeNull()
    expect(problem("name", "ab1")).not.toBeNull()
    expect(problem("name", 3)).not.toBeNull()
  })

  it("keeps an answer sensitive whatever kind of input it becomes", () => {
    const variable = (definition: Record<string, unknown>) => ({
      label: "Value",
      description: "A value.",
      required: false,
      sensitive: true,
      ...definition,
    })
    const { inputs } = brickRecipeFromV1(
      stored((recipe) => ({
        ...recipe,
        variables: {
          token: variable({ type: "string", default: "hunter2" }),
          tier: variable({
            type: "string",
            options: ["gold"],
            default: "gold",
          }),
          pin: variable({ type: "number", default: 1234 }),
          flag: variable({ type: "boolean", default: true }),
        },
        runtime: {
          ...recipe.runtime,
          image: "example:latest",
          name: "Example",
          environment: {},
          resources: { memory: "1G" },
        },
      }))
    )
    expect(
      inputs!.map((input) => [input.key, input.type, input.sensitive])
    ).toEqual([
      ["token", "secret", undefined],
      ["tier", "select", true],
      ["pin", "number", true],
      ["flag", "boolean", true],
    ])
  })

  it("reads a recipe with more variables than a form usually has", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `option_${index}`,
        {
          type: "string",
          label: `Option ${index}`,
          description: "An option.",
          required: false,
        },
      ])
    )
    const read = readBrickRecipe({
      ...v1,
      variables,
      runtime: {
        ...v1.runtime,
        image: "example:latest",
        name: "Example",
        environment: {},
        resources: { memory: "1G" },
      },
    })
    expect(read.success && read.data.inputs).toHaveLength(200)
  })

  // `constructor` is a valid ID, and a name every object already has.
  it("reads a Brick whose ID is the name of something built in", () => {
    const read = readBrickRecipe({
      ...v1,
      metadata: { ...v1.metadata, id: "constructor" },
    })
    expect(read.success && read.data.metadata.id).toBe("constructor")
  })

  // Kiln did these by Brick ID; a converted recipe says them itself.
  it("carries what Kiln did for a Minecraft Brick by its ID", () => {
    const extras = (id: string) =>
      brickRecipeFromV1(
        stored((recipe) => ({
          ...recipe,
          metadata: { ...recipe.metadata, id },
        }))
      ).minecraft
    expect(extras("velocity")).toEqual({ latestVersion: "velocity" })
    expect(extras("paper")).toEqual({ completion: true })
    expect(extras("folia")).toEqual({ completion: true })
    expect(extras("fabric")).toBeUndefined()
  })
})

describe("reading a stored or fetched recipe", () => {
  it("reads a v1 recipe converted and a v2 recipe as it is", () => {
    const fromV1 = readBrickRecipe(v1)
    expect(fromV1.success && fromV1.data).toEqual(brickRecipeFromV1(stored()))
    const again = readBrickRecipe(fromV1.success ? fromV1.data : null)
    expect(again.success && again.data).toEqual(brickRecipeFromV1(stored()))
  })

  it("refuses what is neither", () => {
    expect(readBrickRecipe({ ...v1, format: "kiln.brick/v3" }).success).toBe(
      false
    )
    expect(
      readBrickRecipe({ ...v1, runtime: { ...v1.runtime, privileged: true } })
        .success
    ).toBe(false)
    expect(readBrickRecipe(null).success).toBe(false)
  })

  // Hearth keeps the Bricks people added, and each catalog as it last read
  // it, with where each recipe came from and its icon.
  it("reads a Brick and a catalog Hearth stored while recipes were v1", () => {
    const saved = {
      ...v1,
      iconSvg: '<svg viewBox="0 0 1 1"></svg>',
      source: "https://example.test/paper.yml",
    }
    const expected = {
      ...brickRecipeFromV1(stored()),
      iconSvg: saved.iconSvg,
      source: saved.source,
    }
    const brick = readBrick(saved)
    expect(brick.success && brick.data).toEqual(expected)

    const catalog = readRelayCatalog({
      format: "kiln.catalog/v1",
      name: "Mine",
      bricks: [saved, expected],
    })
    expect(catalog.success && catalog.data.bricks).toEqual([expected, expected])
    // One Brick that can't be read still fails its catalog.
    expect(
      readRelayCatalog({
        format: "kiln.catalog/v1",
        bricks: [{ ...saved, source: undefined }],
      }).success
    ).toBe(false)
  })
})
