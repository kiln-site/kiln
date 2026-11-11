import { describe, expect, it } from "vite-plus/test"

import { brickRecipeSchema } from "./brick-recipe"
import {
  groupBrickInstall,
  groupBrickProblem,
  groupConnectionEnvironment,
} from "./group-bricks"

const group = (members: Record<string, unknown>, inputs?: Array<unknown>) =>
  brickRecipeSchema.parse({
    format: "kiln.brick/v2",
    kind: "group",
    metadata: {
      id: "analytics",
      name: "Analytics",
      summary: "An example.",
      author: "Kiln",
    },
    ...(inputs ? { inputs } : {}),
    group: { members },
  })

const web = {
  kind: "app",
  deploy: { type: "image", image: "ghcr.io/acme/analytics:{{ tag }}" },
  connect: {
    database: {
      DATABASE_URL: "{{ connection }}",
      DATABASE_HOST: "{{ host }}:{{ port }}",
      REGION: "{{ region }}",
    },
  },
}
const inputs = [
  { key: "tag", label: "Tag", type: "text", default: "latest" },
  { key: "region", label: "Region", type: "text", default: "eu" },
]
const analytics = group(
  { database: { brick: "postgres", inputs: { version: "16" } }, web },
  inputs
)

describe("a group Brick", () => {
  it("makes its databases first, then the Apps connected to them", () => {
    expect(groupBrickInstall(analytics, { tag: "2" })).toEqual({
      install: {
        answers: { region: "eu", tag: "2" },
        apps: [
          {
            connect: web.connect,
            environment: {},
            image: "ghcr.io/acme/analytics:2",
            key: "web",
          },
        ],
        databases: [
          { brick: "postgres", key: "database", variables: { version: "16" } },
        ],
      },
    })
  })

  it("gives an App what reaching each database takes, and the group's answers", () => {
    const connection = {
      connection: "postgresql://kiln:secret@database-1:5432/kiln",
      host: "database-1",
      name: "kiln",
      password: "secret",
      port: "5432",
      username: "kiln",
    }
    expect(
      groupConnectionEnvironment(
        web,
        { database: connection },
        { region: "eu" }
      )
    ).toEqual({
      environment: {
        DATABASE_HOST: "database-1:5432",
        DATABASE_URL: connection.connection,
        REGION: "eu",
      },
    })
    // A database that wasn't made gives nothing to connect with.
    expect(groupConnectionEnvironment(web, {}, {})).toEqual({
      problem: "database wasn't made",
    })
    // One variable can't smuggle in another.
    expect(
      groupConnectionEnvironment(
        web,
        { database: { ...connection, host: "x\nADMIN=1" } },
        { region: "eu" }
      )
    ).toEqual({ problem: "DATABASE_HOST can't hold a line break" })
  })

  it("is refused while it does something Kiln doesn't for a group", () => {
    expect(groupBrickProblem(analytics)).toBeNull()
    const refused = (
      members: Record<string, unknown>,
      asked: Array<unknown> = inputs
    ) => groupBrickProblem(group(members, asked))
    expect(
      refused({
        database: { brick: "https://elsewhere.test/postgres.yml" },
        web,
      })
    ).toBe(
      "Kiln installs a group's members from its own catalog only (database)"
    )
    expect(
      refused({
        database: { brick: "postgres" },
        web: {
          ...web,
          deploy: { ...web.deploy, ports: [{ name: "web", port: 3000 }] },
        },
      })
    ).toBe("Kiln doesn't run an App Brick's ports yet (web)")
    expect(
      refused({
        database: { brick: "postgres" },
        web: { ...web, deploy: { type: "compose", path: "compose.yaml" } },
      })
    ).toBe("Kiln installs an App written in a group from an image only (web)")
    expect(
      refused({
        database: { brick: "postgres" },
        web,
        worker: { ...web, connect: { web: { WEB_URL: "{{ host }}" } } },
      })
    ).toBe("Kiln connects an App to a group's databases only (worker)")
  })

  it("refuses answers it can't install from", () => {
    expect(groupBrickInstall(analytics, { tag: 3 })).toEqual({
      problem: "Tag must be text",
    })
    expect(groupBrickInstall(analytics, { colour: "red" })).toEqual({
      problem: "This Brick doesn't ask for colour",
    })
  })
})
