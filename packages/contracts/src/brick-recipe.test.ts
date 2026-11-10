import { describe, expect, it } from "vite-plus/test"
import { z } from "zod"

import {
  brickRecipeV2Schema,
  brickSuggestedValue,
  type BrickInput,
} from "./brick-recipe"

const metadata = {
  id: "example",
  name: "Example",
  summary: "An example.",
  author: "Kiln",
}

const gameServer = {
  format: "kiln.brick/v2",
  kind: "game-server",
  type: "minecraft",
  metadata,
  inputs: [
    { key: "version", label: "Version", type: "text", default: "26.2" },
    {
      key: "java",
      label: "Java",
      type: "select",
      options: ["17", "21", "25"],
      default: "21",
      suggest: [{ when: "version", from: "26.1", value: "25" }],
    },
  ],
  deploy: {
    type: "image",
    image: "ghcr.io/kiln-site/bricks-java:{{ java }}",
    env: { KILN_VERSION: "{{ version }}" },
    ports: [{ name: "game", port: 25565 }],
    volumes: ["/server"],
  },
  "game-server": { game: "Minecraft", stop: ["stop"] },
}

const database = {
  format: "kiln.brick/v2",
  kind: "database",
  type: "postgres",
  metadata,
  deploy: {
    type: "image",
    image: "postgres:17",
    env: { POSTGRES_PASSWORD: "{{ database.password }}" },
    ports: [{ name: "sql", port: 5432 }],
    volumes: ["/var/lib/postgresql/data"],
  },
  database: {
    connection:
      "postgresql://{{ database.username }}:{{ database.password }}@{{ database.host }}:{{ database.port }}/{{ database.name }}",
  },
}

const group = {
  format: "kiln.brick/v2",
  kind: "group",
  metadata,
  inputs: [{ key: "secret", label: "Secret", type: "secret", generate: true }],
  group: {
    members: {
      database: { brick: "postgres" },
      web: {
        kind: "app",
        deploy: {
          type: "image",
          image: "ghcr.io/umami-software/umami:postgresql-latest",
          env: { APP_SECRET: "{{ secret }}" },
          ports: [{ name: "web", port: 3000 }],
        },
        connect: { database: { DATABASE_URL: "{{ connection }}" } },
      },
    },
  },
}

function problems(recipe: unknown): Array<string> {
  const parsed = brickRecipeV2Schema.safeParse(recipe)
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
}

describe("kiln.brick/v2", () => {
  it("accepts a game server, a database and a group", () => {
    expect(problems(gameServer)).toEqual([])
    expect(problems(database)).toEqual([])
    expect(problems(group)).toEqual([])
  })

  it("stores a recipe as it was written", () => {
    expect(brickRecipeV2Schema.parse(gameServer)).toEqual(gameServer)
  })

  it("refuses a field it doesn't know, so a typo can't change a deployment", () => {
    expect(
      problems({
        ...gameServer,
        deploy: { ...gameServer.deploy, privileged: true },
      })
    ).not.toEqual([])
    expect(problems({ ...gameServer, runtime: {} })).not.toEqual([])
  })

  it("refuses a template that names nothing", () => {
    expect(
      problems({
        ...gameServer,
        deploy: { ...gameServer.deploy, image: "java:{{ jdk }}" },
      })
    ).toEqual(["deploy.image: Nothing is named jdk"])
    // What Kiln supplies to a database isn't there for a game server.
    expect(
      problems({
        ...gameServer,
        deploy: {
          ...gameServer.deploy,
          env: { PASSWORD: "{{ database.password }}" },
        },
      })
    ).toEqual(["deploy.env.PASSWORD: Nothing is named database.password"])
    expect(
      problems({
        ...gameServer,
        deploy: { ...gameServer.deploy, image: "java:{{ version" },
      })
    ).toEqual(["deploy.image: Templates are written {{ name }}"])
  })

  it("keeps each section to the kind and type it belongs to", () => {
    expect(problems({ ...gameServer, type: "postgres" })).toContain(
      "type: A game-server can be minecraft, or have no type"
    )
    expect(problems({ ...database, "game-server": { game: "None" } })).toEqual([
      "game-server: Only a game server has this section",
    ])
    expect(problems({ ...gameServer, type: undefined, minecraft: {} })).toEqual(
      ["minecraft: Only the minecraft type has this section"]
    )
    expect(problems({ ...group, deploy: gameServer.deploy })).toEqual([
      "deploy: A group runs nothing itself; its members do",
    ])
  })

  it("refuses inputs and ports that contradict themselves", () => {
    const withInput = (input: Record<string, unknown>) =>
      problems({ ...gameServer, inputs: [...gameServer.inputs, input] })
    expect(withInput({ key: "mode", label: "Mode", type: "select" })).toEqual([
      "inputs.2.options: A select needs options",
    ])
    expect(withInput({ key: "version", label: "Again", type: "text" })).toEqual(
      ["inputs.2.key: Duplicate input version"]
    )
    expect(
      withInput({
        key: "heap",
        label: "Heap",
        type: "number",
        suggest: [{ when: "missing", matches: ".", value: 1 }],
      })
    ).toEqual(["inputs.2.suggest.0.when: No input is named missing"])
    // Its value isn't known until Kiln installs the Brick.
    expect(
      problems({
        ...gameServer,
        inputs: [
          { key: "token", label: "Token", type: "secret", generate: true },
          {
            key: "mode",
            label: "Mode",
            type: "text",
            suggest: [{ when: "token", matches: ".", value: "authenticated" }],
          },
        ],
        deploy: { ...gameServer.deploy, image: "example", env: {} },
      })
    ).toEqual([
      "inputs.1.suggest.0.when: An input can't follow a secret Kiln generates",
    ])
    expect(
      problems({
        ...gameServer,
        deploy: {
          ...gameServer.deploy,
          ports: [
            { name: "game", port: 25565 },
            { name: "game", port: 25566 },
          ],
        },
      })
    ).toEqual(["deploy.ports.1.name: Duplicate port game"])
  })

  it("refuses a group member that connects to nothing", () => {
    expect(
      problems({
        ...group,
        group: {
          members: {
            ...group.group.members,
            web: {
              ...group.group.members.web,
              connect: { cache: { REDIS_URL: "{{ connection }}" } },
            },
          },
        },
      })
    ).toEqual(["group.members.web.connect.cache: No member is named cache"])
  })
})

describe("suggested values", () => {
  const java: BrickInput = {
    key: "java",
    label: "Java",
    type: "select",
    options: ["11", "17", "21", "25"],
    default: "21",
    suggest: [
      { when: "version", from: "26.1", below: "27", value: "25" },
      { when: "version", from: "1.20", below: "1.22", value: "21" },
      { when: "version", from: "1.17", below: "1.20", value: "17" },
      { when: "version", matches: "^legacy$", value: "11" },
    ],
  }
  const suggested = (version: string) => brickSuggestedValue(java, { version })

  it("takes the first rule that applies to the other answer", () => {
    expect(suggested("26.2")).toBe("25")
    expect(suggested("1.21.4")).toBe("21")
    expect(suggested("1.20")).toBe("21")
    expect(suggested("1.19.4")).toBe("17")
    expect(suggested("legacy")).toBe("11")
  })

  it("compares versions by number, whatever follows them", () => {
    // 1.9 is older than 1.17, though it sorts after it as text.
    expect(suggested("1.9")).toBeUndefined()
    expect(suggested("26.1-SNAPSHOT")).toBe("25")
  })

  it("leaves the default when no rule applies or the answer is missing", () => {
    expect(suggested("26.0")).toBeUndefined()
    expect(suggested("latest")).toBeUndefined()
    expect(brickSuggestedValue(java, {})).toBeUndefined()
  })
})

describe("the schema editors read", () => {
  it("is the one generated from the contract", async () => {
    await expect(
      `${JSON.stringify(z.toJSONSchema(brickRecipeV2Schema), null, 2)}\n`
    ).toMatchFileSnapshot("../../../apps/bricks/schema/brick-v2.schema.json")
  })
})
