import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test"

import { loadComposeProject } from "./compose-project.js"

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-compose-"))
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

async function load(yaml: string, environment: Record<string, string> = {}) {
  const warnings: Array<string> = []
  const project = await loadComposeProject({
    environment,
    onWarning: (warning) => warnings.push(warning),
    projectDirectory: directory,
    projectName: "kiln-app-x",
    yaml,
  })
  return { project, warnings }
}

describe("Compose variables", () => {
  it("takes the app's environment over .env, as Compose takes the shell's", async () => {
    await writeFile(
      join(directory, ".env"),
      "TAG=from-dotenv\nNAME=dotenv\nQUOTED=\"a b\"\nSINGLE='${NOT_EXPANDED}'\n"
    )

    const { project, warnings } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx:${TAG}",
        "    environment:",
        "      NAME: ${NAME}",
        "      DEFAULTED: ${MISSING:-fallback}",
        "      SET_EMPTY: ${EMPTY-kept-empty}",
        "      NESTED: ${MISSING:-${NAME}-nested}",
        "      ALTERNATE: ${NAME:+present}",
        "      DOLLARS: $$HOME",
        "      QUOTED: ${QUOTED}",
        "      SINGLE: ${SINGLE}",
        "      UNSET: ${NOWHERE}",
      ].join("\n"),
      { EMPTY: "", NAME: "app" }
    )

    expect(project.services.web?.image).toBe("nginx:from-dotenv")
    expect(project.services.web?.environment).toEqual({
      ALTERNATE: "present",
      DEFAULTED: "fallback",
      DOLLARS: "$HOME",
      NAME: "app",
      NESTED: "app-nested",
      QUOTED: "a b",
      SET_EMPTY: "",
      SINGLE: "${NOT_EXPANDED}",
      UNSET: "",
    })
    expect(warnings).toEqual([
      'The "NOWHERE" variable is not set. Defaulting to a blank string.',
    ])
  })

  it("fails on a required variable without a value, with its message", async () => {
    await expect(
      load(
        "services:\n  web:\n    image: ${IMAGE:?Set IMAGE in the app's environment}\n"
      )
    ).rejects.toThrow(
      "required variable IMAGE is missing a value: Set IMAGE in the app's environment"
    )
  })

  it("merges env_file values under environment and resolves names from the environment", async () => {
    await writeFile(
      join(directory, "web.env"),
      "# comment\nexport FROM_FILE=yes\nOVERRIDDEN=file\nWITH_COMMENT=value # trailing\n"
    )

    const { project } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    env_file: [web.env]",
        "    environment:",
        "      - OVERRIDDEN=environment",
        "      - PASSED_THROUGH",
        "      - NOT_ANYWHERE",
      ].join("\n"),
      { PASSED_THROUGH: "from-app" }
    )

    // A name the environment doesn't set is kept, unset, as Compose keeps
    // it.
    expect(project.services.web?.environment).toEqual({
      FROM_FILE: "yes",
      NOT_ANYWHERE: null,
      OVERRIDDEN: "environment",
      PASSED_THROUGH: "from-app",
      WITH_COMMENT: "value",
    })
  })
})

describe("Compose environments, as Compose resolves them", () => {
  it("expands .env with the app's variables first, and unsets env_file values set to null", async () => {
    await writeFile(
      join(directory, ".env"),
      "CHAINED=${APP_VALUE}-c\nAPP_VALUE=from-dotenv\n"
    )
    await writeFile(
      join(directory, "web.env"),
      "SECRET=from-file\nKEPT=${CHAINED}\n"
    )

    const { project } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    env_file: [web.env]",
        "    environment:",
        "      SECRET: null",
      ].join("\n"),
      { APP_VALUE: "app" }
    )

    expect(project.services.web?.environment).toEqual({
      KEPT: "app-c",
      SECRET: null,
    })
  })

  it("leaves out build arguments without a value the environment doesn't set", async () => {
    const { project } = await load(
      [
        "services:",
        "  web:",
        "    build:",
        "      context: .",
        "      args: [VERSION, FROM_APP, LITERAL=x, EMPTY=]",
      ].join("\n"),
      { FROM_APP: "app" }
    )

    expect(project.services.web?.build?.args).toEqual({
      EMPTY: "",
      FROM_APP: "app",
      LITERAL: "x",
    })
  })
})

describe("Compose short syntax", () => {
  it("publishes a host port range for a single target, and keeps gateway priorities", async () => {
    const { project } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    ports: ['8000-8005:80']",
        "    networks:",
        "      back: { gw_priority: 5 }",
        "networks:",
        "  back:",
      ].join("\n")
    )

    expect(project.services.web?.ports).toEqual([
      { protocol: "tcp", published: "8000-8005", target: 80 },
    ])
    expect(project.services.web?.networks?.back).toEqual({ gw_priority: 5 })
  })

  it("expands ports, volumes, dependencies, and health checks to the long form", async () => {
    const { project } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx",
        '    command: nginx -g "daemon off;"',
        "    ports: ['8080:80', '127.0.0.1:5353:53/udp', '9000-9001:9000-9001', '3000']",
        "    volumes: ['./data:/data:ro', 'cache:/cache', '/scratch']",
        "    depends_on: [db]",
        "    healthcheck:",
        "      test: curl -f http://localhost",
        "      interval: 1m30s",
        "  db:",
        "    image: postgres",
        "    stop_grace_period: 1m",
        "volumes:",
        "  cache:",
      ].join("\n")
    )

    const web = project.services.web!
    expect(web.command).toEqual(["nginx", "-g", "daemon off;"])
    expect(web.ports).toEqual([
      { protocol: "tcp", published: "8080", target: 80 },
      { host_ip: "127.0.0.1", protocol: "udp", published: "5353", target: 53 },
      { protocol: "tcp", published: "9000", target: 9000 },
      { protocol: "tcp", published: "9001", target: 9001 },
      { protocol: "tcp", target: 3000 },
    ])
    expect(web.volumes).toEqual([
      {
        bind: {},
        read_only: true,
        source: join(directory, "data"),
        target: "/data",
        type: "bind",
      },
      { source: "cache", target: "/cache", type: "volume", volume: {} },
      { target: "/scratch", type: "volume", volume: {} },
    ])
    expect(web.depends_on).toEqual({
      db: { condition: "service_started", required: true, restart: false },
    })
    expect(web.healthcheck).toEqual({
      interval: 90e9,
      test: ["CMD-SHELL", "curl -f http://localhost"],
    })
    expect(project.services.db?.stop_grace_period).toBe(60e9)
    expect(project.networks).toEqual({
      default: { name: "kiln-app-x_default" },
    })
    expect(project.volumes).toEqual({ cache: { name: "kiln-app-x_cache" } })
  })
})

describe("Compose features Kiln can't run", () => {
  it.each([
    [
      "links",
      "services:\n  web:\n    image: nginx\n    links: [db]\n  db:\n    image: postgres\n",
      '`links` on service "web"',
    ],
    [
      "extends",
      "services:\n  web:\n    extends: { file: base.yaml, service: web }\n",
      '`extends` on service "web"',
    ],
    [
      "replicas",
      "services:\n  web:\n    image: nginx\n    deploy: { replicas: 3 }\n",
      "a number of containers other than one",
    ],
    [
      "a remote build",
      "services:\n  web:\n    build: https://github.com/example/app.git\n",
      "remote build contexts",
    ],
    [
      "YAML override tags",
      "services:\n  web:\n    image: nginx\n    ports: !reset []\n",
      "YAML tag",
    ],
  ])("rejects %s with an error naming it", async (_, yaml, message) => {
    await expect(load(yaml)).rejects.toThrow(message)
  })

  it("rejects a dependency on an undefined service and dependency cycles", async () => {
    await expect(
      load("services:\n  web:\n    image: nginx\n    depends_on: [db]\n")
    ).rejects.toThrow('service "web" depends on undefined service "db"')
    await expect(
      load(
        "services:\n  a:\n    image: nginx\n    depends_on: [b]\n  b:\n    image: nginx\n    depends_on: [a]\n"
      )
    ).rejects.toThrow("dependency cycle detected")
  })

  it("leaves out services in a profile, which no deploy activates", async () => {
    const { project } = await load(
      "services:\n  web:\n    image: nginx\n  debug:\n    image: busybox\n    profiles: [debug]\n"
    )

    expect(Object.keys(project.services)).toEqual(["web"])
  })
})
