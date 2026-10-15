import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test"

import { loadComposeProject } from "./compose-load.js"
import { readComposeProject } from "./compose-project.js"
import { loadConfig } from "./config.js"

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-compose-"))
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

// The Relay's load, in its worker, with the configured timeout.
function loading(
  yaml: string,
  environment: Record<string, string> = {},
  configuration: NodeJS.ProcessEnv = {}
) {
  const warnings: Array<string> = []
  const config = loadConfig({ NODE_ENV: "development", ...configuration })
  return {
    effect: loadComposeProject(
      {
        environment,
        onWarning: (warning) => warnings.push(warning),
        projectDirectory: directory,
        projectName: "kiln-app-x",
        yaml,
      },
      { timeoutMs: config.composeLoadTimeoutMs }
    ),
    warnings,
  }
}

// The load itself, on this thread, for how long its own work takes, apart
// from the worker's start (which is slow under tsx in tests).
async function read(yaml: string, environment: Record<string, string> = {}) {
  const project = await readComposeProject({
    environment,
    onWarning: () => undefined,
    projectDirectory: directory,
    projectName: "kiln-app-x",
    yaml,
  })
  return { project }
}

async function load(yaml: string, environment: Record<string, string> = {}) {
  const { effect, warnings } = loading(yaml, environment)
  const project = await Effect.runPromise(effect)
  return { project, warnings }
}

// 20,000 anchors each aliased once, which the YAML library resolves in
// time quadratic in their number: seconds of work for the worker.
const slowToLoad = [
  "services:",
  "  web:",
  "    image: nginx",
  `x-pairs: [${Array.from({ length: 20_000 }, (_, index) => `&a${index} x, *a${index}`).join(", ")}]`,
].join("\n")

// The longest gap between ticks of a 10 ms timer on this thread while
// `work` runs.
async function longestStall(work: Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 10)
  await work.catch(() => undefined)
  clearInterval(timer)
  return longest
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

describe("Compose env files", () => {
  it("reads a raw env_file as docker run --env-file does, without quotes or interpolation", async () => {
    await writeFile(
      join(directory, "raw.env"),
      "\uFEFF# comment\n  QUOTED=\"a b\"\nSINGLE='${HOME}'\nTRAILING=value # kept \r\nEMPTY=\nPASSED_THROUGH\nNOT_ANYWHERE\n"
    )

    const { project } = await load(
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    env_file: [{ path: raw.env, format: raw }]",
      ].join("\n"),
      { PASSED_THROUGH: "from-app" }
    )

    expect(project.services.web?.environment).toEqual({
      EMPTY: "",
      PASSED_THROUGH: "from-app",
      QUOTED: '"a b"',
      SINGLE: "'${HOME}'",
      TRAILING: "value # kept ",
    })
  })

  it("rejects a raw env_file key with whitespace", async () => {
    await writeFile(join(directory, "raw.env"), "BAD KEY=value\n")

    await expect(
      load(
        "services:\n  web:\n    image: nginx\n    env_file: [{ path: raw.env, format: raw }]\n"
      )
    ).rejects.toThrow("variable 'BAD KEY' contains whitespaces")
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
      "services:\n  web:\n    image: nginx\n    profiles: []\n  debug:\n    image: busybox\n    profiles: [debug]\n"
    )

    // An empty list is no profile, as Compose reads it.
    expect(Object.keys(project.services)).toEqual(["web"])
  })

  // Numbers past what a port or a 64-bit setting holds once looped or
  // multiplied without end.
  it.each([
    ["an exposed port past 2^53", "expose: ['9007199254740992-9007199254740992']"],
    ["an exposed port past 65535", "expose: ['65536']"],
    ["a long-syntax target past 65535", "ports: [{ target: 70000 }]"],
    ["a memory limit past 2^53", "mem_limit: 99999999999999999999"],
    ["a duration past 2^53", "stop_grace_period: 99999999999h"],
    ["CPUs past 2^53", "cpus: 1e300"],
    ["a whole number past 2^53", "pids_limit: 9007199254740993"],
  ])("rejects %s", async (_, line) => {
    await expect(
      load(`services:\n  web:\n    image: nginx\n    ${line}\n`)
    ).rejects.toThrow(/out of range|invalid port|whole number/u)
  })

  it("rejects port ranges that add up past every port of every protocol", async () => {
    const ranges = Array.from({ length: 4 }, () => "'0-65535'").join(", ")

    await expect(
      load(`services:\n  web:\n    image: nginx\n    expose: [${ranges}]\n`)
    ).rejects.toThrow("lists more than 196608 ports")
    await expect(
      load(`services:\n  web:\n    image: nginx\n    ports: [${ranges}]\n`)
    ).rejects.toThrow("lists more than 196608 ports")
  })

  it("keeps one of each port, as Compose does, however many times it's listed", async () => {
    const repeated = Array.from({ length: 65_000 }, () => "'80'").join(", ")

    const started = performance.now()
    const { project } = await read(
      `services:\n  web:\n    image: nginx\n    ports: [${repeated}, { target: 80, published: "8080" }, '8080:80']\n    expose: ['90', '90']\n`
    )

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(project.services.web?.ports).toEqual([
      { protocol: "tcp", target: 80 },
      { protocol: "tcp", published: "8080", target: 80 },
    ])
    expect(project.services.web?.expose).toEqual(["90"])
  })

  it("takes -1 for unlimited where Compose does", async () => {
    const { project } = await load(
      "services:\n  web:\n    image: nginx\n    memswap_limit: -1\n    pids_limit: -1\n"
    )

    expect(project.services.web).toMatchObject({
      memswap_limit: -1,
      pids_limit: -1,
    })
  })
})

describe("Compose files, loaded off the Relay's thread", { timeout: 30_000 }, () => {
  it("stops a load past its configured time, while this thread keeps running", async () => {
    const { effect } = loading(slowToLoad, {}, {
      KILN_RELAY_COMPOSE_LOAD_TIMEOUT: "1",
    })
    const result = Effect.runPromise(effect)

    const stall = await longestStall(result)

    await expect(result).rejects.toThrow(
      "Compose file is too large or complex to load: loading it took longer than 1 s"
    )
    expect(stall).toBeLessThan(250)
  })

  it("terminates the worker when the load is interrupted", async () => {
    const fiber = Effect.runFork(loading(slowToLoad).effect)
    // Let the worker start churning.
    await longestStall(new Promise((resolve) => setTimeout(resolve, 300)))

    await Effect.runPromise(Fiber.interrupt(fiber))

    // With the worker gone, the process has nothing left to compute.
    const before = process.cpuUsage()
    await longestStall(new Promise((resolve) => setTimeout(resolve, 300)))
    const used = process.cpuUsage(before)
    expect((used.user + used.system) / 1_000).toBeLessThan(150)
  })

  it("names the memory limit when a load runs out of it", async () => {
    // Merge keys copying a 5,000-entry mapping into 500 more.
    const yaml = [
      `x-base: &base {${Array.from({ length: 5_000 }, (_, index) => `k${index}: v`).join(", ")}}`,
      ...Array.from({ length: 500 }, (_, index) => `x-copy-${index}: { <<: *base }`),
      "services:",
      "  web:",
      "    image: nginx",
    ].join("\n")

    await expect(load(yaml)).rejects.toThrow(
      /Compose file is too large or complex to load|comes to more than 100000 values/u
    )
  })
})

describe("Compose files, bounded", () => {
  it("checks 30,000 keys for duplicates in time linear in their number", async () => {
    const keys = Array.from({ length: 30_000 }, (_, index) => `k${index}: v`)

    const started = performance.now()
    const { project } = await read(
      `services:\n  web:\n    image: nginx\n    labels: {${keys.join(", ")}}\n`
    )
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(Object.keys(project.services.web?.labels ?? {})).toHaveLength(30_000)

    await expect(
      read(`services:\n  web:\n    image: nginx\n    labels: {${keys.join(", ")}, k7: again}\n`)
    ).rejects.toThrow('The Compose file is not valid YAML: Map keys must be unique ("k7")')
  })

  it("refuses a list or mapping used as a key", async () => {
    await expect(
      load(`services:\n  web:\n    image: nginx\n    labels: { ? ${"[".repeat(300)}${"]".repeat(300)} : x }\n`)
    ).rejects.toThrow("The Compose file uses a list or mapping as a key")
  })

  it("refuses aliases that expand past what it reads, before walking them", async () => {
    // 62 KB: a 30,000-entry list, aliased 300 times.
    const yaml = [
      `x-big: &big [${Array.from({ length: 30_000 }, () => "a").join(",")}]`,
      "services:",
      "  web:",
      "    image: nginx",
      ...Array.from({ length: 300 }, (_, index) => `x-copy-${index}: *big`),
    ].join("\n")

    const started = performance.now()
    await expect(read(yaml)).rejects.toThrow(
      "The Compose file comes to more than 100000 values with its aliases expanded"
    )
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("reads an alias used many times once, with its variables", async () => {
    const { project } = await load(
      [
        "x-env: &env",
        ...Array.from({ length: 1_000 }, (_, index) => `  K${index}: \${VALUE}`),
        "services:",
        ...Array.from({ length: 50 }, (_, index) =>
          [`  s${index}:`, "    image: nginx", "    environment: *env"].join("\n")
        ),
      ].join("\n"),
      { VALUE: "set" }
    )

    expect(Object.keys(project.services)).toHaveLength(50)
    expect(project.services.s49?.environment?.K999).toBe("set")
  })

  it("refuses a file nested deeper than it reads", async () => {
    await expect(
      load(`services:\n  web:\n    image: nginx\n    labels: { a: ${"[".repeat(300)}${"]".repeat(300)} }\n`)
    ).rejects.toThrow("The Compose file nests deeper than 256 levels")
  })

  it("orders a long chain of dependencies without recursing on its length", async () => {
    const { project } = await load(
      [
        "services:",
        ...Array.from({ length: 5_000 }, (_, index) =>
          [
            `  s${index}:`,
            "    image: nginx",
            ...(index > 0 ? [`    depends_on: [s${index - 1}]`] : []),
          ].join("\n")
        ),
      ].join("\n")
    )

    expect(Object.keys(project.services)).toHaveLength(5_000)
  })
})

describe("Compose variable substitution, bounded", () => {
  it("substitutes 55,000 defaults on one line in time linear in its length", async () => {
    const started = performance.now()
    const { project } = await read(
      `services:\n  web:\n    image: nginx\n    environment:\n      LONG: "${"${UNSET:-x}".repeat(55_000)}"\n`
    )

    expect(project.services.web?.environment?.LONG).toBe("x".repeat(55_000))
    expect(performance.now() - started).toBeLessThan(3_000)
  })

  it("substitutes a thousand defaults on one line, one after another", async () => {
    const { project } = await load(
      `services:\n  web:\n    image: nginx\n    environment:\n      LONG: "${"${UNSET:-x}".repeat(1_000)}"\n`
    )

    expect(project.services.web?.environment?.LONG).toBe("x".repeat(1_000))
  })

  it("refuses defaults nested deeper than it reads", async () => {
    const nested = `${"${A:-".repeat(101)}x${"}".repeat(101)}`

    await expect(
      load(`services:\n  web:\n    image: nginx\n    environment:\n      DEEP: "${nested}"\n`)
    ).rejects.toThrow("variable defaults nest more than 100 deep")
  })

  it("refuses a .env whose values double without end", async () => {
    await writeFile(
      join(directory, ".env"),
      ["A=x", ...Array.from({ length: 25 }, () => "A=${A}${A}")].join("\n")
    )

    const started = performance.now()
    await expect(load("services:\n  web:\n    image: nginx\n")).rejects.toThrow(
      "a value is longer than 1048576 characters once its variables are substituted"
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it("refuses a Compose file whose substitutions add up past the limit", async () => {
    const references = Array.from({ length: 40 }, (_, index) => `      V${index}: \${BIG}`)

    await expect(
      load(
        ["services:", "  web:", "    image: nginx", "    environment:", ...references].join("\n"),
        { BIG: "x".repeat(512 * 1024) }
      )
    ).rejects.toThrow("substituting variables produces more than 16777216 characters")
  })

  it("refuses an env file larger than it reads", async () => {
    await writeFile(join(directory, "big.env"), `A=${"x".repeat(4 * 1024 * 1024)}`)

    await expect(
      load("services:\n  web:\n    image: nginx\n    env_file: big.env\n")
    ).rejects.toThrow("Kiln reads files of up to 4194304")
  })
})
