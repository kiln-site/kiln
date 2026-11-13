import { describe, expect, it } from "vite-plus/test"
import { z } from "zod"

import {
  brickAnswers,
  brickAnswersProblem,
  brickFollowers,
  brickNamespace,
  brickReference,
  brickShownReference,
  brickSourceLineage,
  brickRecipeSchema,
  brickSuggestedValue,
  redactedBrickInputs,
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
  const parsed = brickRecipeSchema.safeParse(recipe)
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
    expect(brickRecipeSchema.parse(gameServer)).toEqual(gameServer)
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
    // Round in a circle, no set of answers has to satisfy every rule.
    expect(
      problems({
        ...gameServer,
        inputs: [
          {
            key: "a",
            label: "A",
            type: "text",
            suggest: [{ when: "c", matches: ".", value: "x" }],
          },
          {
            key: "b",
            label: "B",
            type: "text",
            suggest: [{ when: "a", matches: ".", value: "x" }],
          },
          {
            key: "c",
            label: "C",
            type: "text",
            suggest: [{ when: "b", matches: ".", value: "x" }],
          },
        ],
        deploy: { ...gameServer.deploy, image: "example", env: {} },
      })
    ).toEqual([
      "inputs.0.suggest: Inputs can't follow each other in a circle",
      "inputs.1.suggest: Inputs can't follow each other in a circle",
      "inputs.2.suggest: Inputs can't follow each other in a circle",
    ])
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

describe("working out answers", () => {
  // Written out of order on purpose: each follows the one after it.
  const inputs: Array<BrickInput> = [
    {
      key: "image",
      label: "Image",
      type: "text",
      default: "stable-image",
      suggest: [{ when: "tag", matches: "^edge$", value: "edge-image" }],
    },
    {
      key: "tag",
      label: "Tag",
      type: "select",
      options: ["stable", "edge"],
      suggest: [{ when: "channel", matches: "^new$", value: "edge" }],
    },
    {
      key: "channel",
      label: "Channel",
      type: "select",
      options: ["old", "new"],
      default: "old",
    },
    { key: "motd", label: "Message", type: "text", optional: true },
  ]

  it("gives each input what was answered, else its rules, else its default", () => {
    expect(brickAnswers(inputs, {})).toEqual({
      channel: "old",
      image: "stable-image",
    })
    // One answer reaches everything that follows it, through other inputs.
    expect(brickAnswers(inputs, { channel: "new" })).toEqual({
      channel: "new",
      tag: "edge",
      image: "edge-image",
    })
    // An answer stands even where a rule would have said otherwise.
    expect(brickAnswers(inputs, { channel: "new", tag: "stable" })).toEqual({
      channel: "new",
      tag: "stable",
      image: "stable-image",
    })
  })

  it("works out again only what follows the answer that changed", () => {
    const followers = brickFollowers(inputs, "channel")
    expect([...followers].sort()).toEqual(["image", "tag"])
    // The tag had a value only because of the old channel answer; it has no
    // default, so it goes. The message nobody answered stays unanswered.
    expect(
      brickAnswers(
        inputs,
        { channel: "old", tag: "edge", image: "edge-image" },
        followers
      )
    ).toEqual({ channel: "old", image: "stable-image" })
    expect(
      brickAnswers(inputs, { channel: "new", tag: "stable" }, followers)
    ).toEqual({ channel: "new", tag: "edge", image: "edge-image" })
    expect(brickFollowers(inputs, "image").size).toBe(0)
  })

  it("refuses what a rule asks for and the input doesn't offer", () => {
    const tag: BrickInput = {
      key: "tag",
      label: "Tag",
      type: "select",
      options: ["stable"],
      default: "stable",
      suggest: [{ when: "channel", matches: "^new$", value: "edge" }],
    }
    const channel = inputs[2]!
    // Worked out, it holds the value asked for, never its default instead.
    const answers = brickAnswers([channel, tag], { channel: "new" })
    expect(answers.tag).toBe("edge")
    expect(brickAnswersProblem([channel, tag], answers)).toEqual({
      code: "unsupported_suggestion",
      key: "tag",
      message: "Channel new needs Tag edge, which this Brick doesn't offer",
    })
    // Someone can still choose what it does offer.
    expect(
      brickAnswersProblem([channel, tag], { channel: "new", tag: "stable" })
    ).toBeNull()
    // A sensitive answer on either side stays out of the message.
    const problem = brickAnswersProblem(
      [channel, { ...tag, sensitive: true }],
      answers
    )
    expect(problem?.code).toBe("unsupported_suggestion")
    expect(problem?.message).not.toMatch(/edge|new/u)
  })

  it("says which answer is missing or refused, and makes no secret required", () => {
    const token: BrickInput = {
      key: "token",
      label: "Token",
      type: "secret",
      generate: true,
    }
    const name: BrickInput = {
      key: "name",
      label: "Name",
      type: "text",
      pattern: "^[a-z]+$",
    }
    expect(brickAnswersProblem([token, name], {})).toEqual({
      code: "missing",
      key: "name",
      message: "Name is required",
    })
    expect(
      brickAnswersProblem([token, name], { name: "Not Valid" })?.code
    ).toBe("invalid")
    expect(brickAnswersProblem([token, name], { name: "valid" })).toBeNull()
  })
})

describe("showing a recipe", () => {
  it("leaves out what a sensitive input holds, whatever its type", () => {
    const shown = redactedBrickInputs([
      {
        key: "token",
        label: "Token",
        type: "secret",
        default: "hunter2",
        suggest: [{ when: "name", matches: "^admin$", value: "hunter3" }],
      },
      {
        key: "tier",
        label: "Tier",
        type: "select",
        sensitive: true,
        options: ["gold", "silver"],
        default: "gold",
      },
      { key: "pin", label: "PIN", type: "number", sensitive: true, default: 1 },
      { key: "name", label: "Name", type: "text", default: "public" },
    ])
    expect(JSON.stringify(shown)).not.toMatch(/hunter|gold|silver/u)
    expect(shown.map((input) => input.default)).toEqual([
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "public",
    ])
  })
})

describe("the schema editors read", () => {
  it("is the one generated from the contract", async () => {
    await expect(
      `${JSON.stringify(z.toJSONSchema(brickRecipeSchema), null, 2)}\n`
    ).toMatchFileSnapshot("../../../apps/bricks/schema/brick-v2.schema.json")
  })
})

describe("where a Brick comes from", () => {
  // A catalog in a GitHub repository is read at a commit, which its Bricks'
  // sources name: an instance installed at one commit has to find its
  // Brick's newer revision at another.
  it("knows a Brick read at another commit of its repository as the same one", () => {
    const at = (
      commit: string,
      file = "bricks/paper.yml",
      repository = "kiln-site/kiln"
    ) =>
      `https://raw.githubusercontent.com/${repository}/${commit}/apps/bricks/${file}`
    const installed = brickSourceLineage(at("a".repeat(40)))
    expect(brickSourceLineage(at("b".repeat(40)))).toBe(installed)
    expect(brickSourceLineage(at("main"))).toBe(installed)
    expect(brickSourceLineage(at("a".repeat(40), "bricks/folia.yml"))).not.toBe(
      installed
    )
    expect(
      brickSourceLineage(at("a".repeat(40), "bricks/paper.yml", "someone/kiln"))
    ).not.toBe(installed)
    // Anywhere else, a source is only itself.
    expect(brickSourceLineage("https://example.com/v1/paper.yml")).not.toBe(
      brickSourceLineage("https://example.com/v2/paper.yml")
    )
  })

  // Whose a Brick is decides whether it reads as one of Kiln's own, so it
  // comes from the address alone, which only that account can serve.
  it("names a Brick after the account or host its recipe is kept on", () => {
    const own = "kiln-site"
    const named = (source: string) =>
      brickReference({ metadata: { id: "paper" }, source }, own)
    const github = (owner: string, commit = "main") =>
      `https://raw.githubusercontent.com/${owner}/bricks/${commit}/paper.yml`
    expect(named(github("Billy"))).toBe("billy:paper")
    expect(named(github("billy", "a".repeat(40)))).toBe("billy:paper")
    expect(named("https://gitlab.com/billy/bricks/-/raw/main/paper.yml")).toBe(
      "gitlab.com/billy:paper"
    )
    expect(named("https://example.com/paper.yml")).toBe("example.com:paper")
    // Read from this installation's own files.
    expect(named("file:///workspace/apps/bricks/bricks/paper.yml")).toBe(
      "kiln-site:paper"
    )
    // No address that isn't that account's on GitHub is taken for it.
    for (const source of [
      "https://raw.githubusercontent.com.example.com/kiln-site/kiln/main/paper.yml",
      "https://raw.githubusercontent.com@example.com/kiln-site/kiln/main/paper.yml",
      "https://someone@raw.githubusercontent.com/kiln-site/kiln/main/paper.yml",
      "https://example.com/kiln-site/kiln/main/paper.yml",
      "https://kiln-site/paper.yml",
      "https://raw.githubusercontent.com/kiln-site/kiln/../../billy/bricks/main/paper.yml",
    ]) {
      expect(brickNamespace(source, own)).not.toBe(own)
    }
    // One of Kiln's own goes by its ID alone where it is shown.
    const shown = (source: string) =>
      brickShownReference({ metadata: { id: "paper" }, source }, own)
    expect(shown(github("kiln-site"))).toBe("paper")
    expect(shown(github("billy"))).toBe("billy:paper")
  })
})
