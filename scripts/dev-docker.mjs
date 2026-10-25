import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const command = process.argv[2] ?? "start"
const initialDirectory = process.cwd()
const worktreeRoot = captureAt(initialDirectory, "git", [
  "rev-parse",
  "--show-toplevel",
])
const commonGitDirectory = resolve(
  worktreeRoot,
  git("rev-parse", "--git-common-dir")
)
const primaryRoot = dirname(commonGitDirectory)
const primaryWorktree = resolve(worktreeRoot) === resolve(primaryRoot)
// Keep the first branch-derived name across branch switches, including cleanup.
const projectFile = resolve(
  worktreeRoot,
  git("rev-parse", "--git-path", "kiln-dev-project")
)
const stack = projectName()
const namespace = primaryWorktree ? "" : stack
const environmentFile = resolve(primaryRoot, ".env")
const network = developmentNetwork()
const orbstack = network === "orbstack"
const webPort = developmentPort("KILN_DEV_WEB_PORT", 3000)
const mysqlPort = developmentPort("KILN_DEV_MYSQL_PORT", 3306)
const sftpPort = developmentPort("KILN_DEV_SFTP_PORT", 2022)
const hearthUrl = orbstack
  ? `https://${stack}.orb.local`
  : `http://localhost:${webPort}`
const relayHost = orbstack ? `relay.${stack}.orb.local` : "relay"
const relayUrl = orbstack ? `https://${relayHost}` : `https://${relayHost}:4100`
const composeFiles = [
  resolve(worktreeRoot, "compose.dev.yaml"),
  ...(orbstack ? [resolve(worktreeRoot, "compose.dev.orbstack.yaml")] : []),
]

if (command === "setup") {
  setupEnvironment()
  ensureSharedStore()
  console.log(`Development environment is ready at ${environmentFile}`)
  process.exit(0)
}

requireEnvironment()
if (["start", "up", "down", "destroy", "refresh"].includes(command)) {
  requireProjectOwnership()
}
if (["start", "up", "refresh"].includes(command)) {
  writeFileSync(projectFile, `${stack}\n`)
}
if (command === "start" || command === "up" || command === "refresh") {
  ensureSharedStore()
}

const composeEnvironment = {
  ...process.env,
  KILN_DEV_ENV_FILE: environmentFile,
  KILN_DEV_WEB_PORT: String(webPort),
  KILN_DEV_MYSQL_PORT: String(mysqlPort),
  KILN_DEV_SFTP_PORT: String(sftpPort),
  KILN_INSTALLATION_ID: stack,
  KILN_RELAY_GAME_HOST: process.env.KILN_RELAY_GAME_HOST?.trim() || "localhost",
  KILN_RELAY_HOST: relayHost,
  KILN_RELAY_PORT: "4100",
  KILN_RELAY_SFTP_PORT: "2022",
  // Bootstrap uses the direct managed-TLS endpoint, not the OrbStack edge.
  KILN_RELAY_PUBLIC_URL: "",
  KILN_RELAY_CONTROL_URL: "",
  KILN_RELAY_NAME: `D001-${createHash("sha256").update(resolve(worktreeRoot)).digest("hex").slice(0, 8)}`,
  KILN_RELAY_PROXY: orbstack ? "none" : "hearth",
  KILN_RELAY_PUBLIC_PORT: orbstack ? "443" : "4100",
  KILN_RELAY_RESOURCE_NAMESPACE: namespace,
  KILN_URL: hearthUrl,
}

switch (command) {
  case "start":
    printStack()
    compose(["up", "hearth"], composeEnvironment)
    break
  case "up":
    printStack()
    compose(["up", "--detach", "--wait", "hearth"], composeEnvironment)
    console.log("\nDevelopment stack is ready.")
    break
  case "down":
    compose(["down"], composeEnvironment)
    break
  case "destroy":
    destroyNamespacedContainers()
    compose(["down"], composeEnvironment)
    destroyNamespacedNetworks()
    compose(["down", "--volumes", "--remove-orphans"], composeEnvironment)
    break
  case "logs":
    compose(["logs", "--follow", "hearth", "relay"], composeEnvironment)
    break
  case "refresh":
    refresh()
    break
  case "url":
    console.log(hearthUrl)
    break
  case "test":
    // Web tests, including the real-MySQL suites, against this stack's MySQL.
    run(
      "pnpm",
      ["exec", "vp", "test", "run", ...process.argv.slice(3)],
      {
        ...process.env,
        KILN_TEST_MYSQL: "1",
        DB_HOST: orbstack ? `mysql.${stack}.orb.local` : "127.0.0.1",
        DB_PORT: orbstack ? "3306" : String(mysqlPort),
        DB_NAME: process.env.KILN_TEST_DB_NAME ?? "kiln_test",
        DB_USERNAME: "root",
        DB_PASSWORD: "kiln-root",
      },
      resolve(worktreeRoot, "apps/web")
    )
    break
  case "list":
    run("docker", ["compose", "ls"], process.env)
    break
  default:
    fail(`Unknown development Docker command: ${command}`)
}

function compose(arguments_, environment) {
  run(
    "docker",
    [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      stack,
      ...composeFiles.flatMap((file) => ["--file", file]),
      ...arguments_,
    ],
    environment
  )
}

function requireNamespaceForDestroy() {
  if (!namespace) {
    fail(
      "Refusing to destroy unscoped Relay resources from the primary worktree. Use dev:docker:down, or remove primary development data deliberately."
    )
  }
}

function destroyNamespacedContainers() {
  requireNamespaceForDestroy()
  const containers = capture("docker", [
    "container",
    "ls",
    "--all",
    "--filter",
    `label=kiln.relay.owner=${namespace}`,
    "--format",
    "{{.ID}}",
  ])
    .split("\n")
    .filter(Boolean)
  if (containers.length > 0) {
    run("docker", ["container", "rm", "--force", ...containers], process.env)
  }
}

function destroyNamespacedNetworks() {
  requireNamespaceForDestroy()
  const networks = capture("docker", [
    "network",
    "ls",
    "--filter",
    `label=kiln.relay.owner=${namespace}`,
    "--format",
    "{{.ID}}",
  ])
    .split("\n")
    .filter(Boolean)
  if (networks.length > 0) {
    run("docker", ["network", "rm", ...networks], process.env)
  }
}

function ensureSharedStore() {
  const volume = "kiln-dev-pnpm-store"
  const docker = (arguments_) =>
    spawnSync("docker", arguments_, {
      cwd: worktreeRoot,
      encoding: "utf8",
      env: process.env,
    })
  const inspect = () => docker(["volume", "inspect", volume])
  if (inspect().status === 0) return

  // Another worktree can create the shared volume at the same time.
  const created = docker(["volume", "create", volume])
  if (created.status === 0 || inspect().status === 0) return
  const detail = created.stderr?.trim()
  fail(
    detail
      ? `Could not create Docker volume ${volume}: ${detail}`
      : `Could not create Docker volume ${volume}.`
  )
}

function refresh() {
  const services = ["cache", "mysql", "relay", "hearth"]
  const running = services.every((service) =>
    captureCompose(["ps", "--quiet", service], composeEnvironment)
  )
  if (!running) {
    printStack()
    compose(["up", "--detach", "--wait", "hearth"], composeEnvironment)
    return
  }
  compose(["restart", "relay"], composeEnvironment)
  waitForService("relay")
  compose(["restart", "hearth"], composeEnvironment)
  waitForService("hearth")
  console.log("The development stack is refreshed and healthy.")
}

function waitForService(service) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const container = captureCompose(
      ["ps", "--quiet", service],
      composeEnvironment
    )
    if (container) {
      const status = capture("docker", [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        container,
      ])
      if (status === "healthy" || status === "running") return
      if (status === "exited" || status === "dead") {
        compose(["logs", "--tail", "80", service], composeEnvironment)
        fail(`${service} stopped before becoming ready.`)
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  }
  fail(`Timed out waiting for ${service} to become ready.`)
}

function captureCompose(arguments_, environment) {
  return capture(
    "docker",
    [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      stack,
      ...composeFiles.flatMap((file) => ["--file", file]),
      ...arguments_,
    ],
    environment
  )
}

function printStack() {
  console.log(`Stack:  ${stack} (${network})`)
  console.log(`Hearth: ${hearthUrl}`)
  console.log(
    `Relay:  ${relayUrl}${orbstack ? "" : " (internal; browser traffic goes through Hearth)"}\n`
  )
}

function setupEnvironment() {
  if (!existsSync(environmentFile)) {
    // This checkout's template: the primary checkout may be on another
    // revision. The .env it makes is shared.
    const example = resolve(worktreeRoot, ".env.dev.example")
    if (!existsSync(example)) fail(`Missing environment template: ${example}`)
    writeFileSync(environmentFile, readFileSync(example, "utf8"), {
      mode: 0o600,
    })
  }
  const values = parseEnvironment(readFileSync(environmentFile, "utf8"))
  const replacements = new Map()
  if (
    !usableSecret(values.get("DB_PASSWORD")) ||
    values.get("DB_PASSWORD") === "replace-with-a-strong-database-password"
  ) {
    replacements.set("DB_PASSWORD", secret(32))
  }
  const authSecrets = values.get("BETTER_AUTH_SECRETS")
  if (!authSecrets || authSecrets === "1:") {
    replacements.set("BETTER_AUTH_SECRETS", `1:${secret(48)}`)
  }
  if (!usableSecret(values.get("KILN_RELAY_BOOTSTRAP_TOKEN"))) {
    replacements.set("KILN_RELAY_BOOTSTRAP_TOKEN", secret(48))
  }
  if (!usableSecret(values.get("KILN_PLATFORM_BACKUP_KEY"))) {
    replacements.set("KILN_PLATFORM_BACKUP_KEY", secret(48))
  }
  chmodSync(environmentFile, 0o600)
  if (replacements.size === 0) return

  const current = readFileSync(environmentFile, "utf8")
  const updated = [...replacements].reduce(
    (contents, [name, value]) => setEnvironmentValue(contents, name, value),
    current
  )
  writeFileSync(environmentFile, updated, { mode: 0o600 })
}

function requireEnvironment() {
  if (!existsSync(environmentFile)) {
    fail(
      `Missing ${environmentFile}. Run pnpm dev:setup once from any worktree.`
    )
  }
  const values = parseEnvironment(readFileSync(environmentFile, "utf8"))
  const missing = []
  if (!usableSecret(values.get("DB_PASSWORD"))) missing.push("DB_PASSWORD")
  if (!usableSecret(values.get("BETTER_AUTH_SECRETS"))) {
    missing.push("BETTER_AUTH_SECRETS")
  }
  if (!usableSecret(values.get("KILN_RELAY_BOOTSTRAP_TOKEN"))) {
    missing.push("KILN_RELAY_BOOTSTRAP_TOKEN")
  }
  if (!usableSecret(values.get("KILN_PLATFORM_BACKUP_KEY"))) {
    missing.push("KILN_PLATFORM_BACKUP_KEY")
  }
  if (missing.length > 0) {
    fail(
      `Missing required development values (${missing.join(", ")}) in ${environmentFile}. Run pnpm dev:setup.`
    )
  }
}

function parseEnvironment(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

function setEnvironmentValue(contents, name, value) {
  const expression = new RegExp(`^${name}=.*$`, "mu")
  if (expression.test(contents)) {
    return contents.replace(expression, `${name}=${value}`)
  }
  return `${contents.replace(/\s*$/u, "")}\n${name}=${value}\n`
}

function usableSecret(value) {
  return Boolean(value && value.trim() && !value.includes("replace-with"))
}

function secret(bytes) {
  return randomBytes(bytes).toString("base64url")
}

function projectName() {
  const override = process.env.KILN_DEV_PROJECT?.trim()
  const saved = existsSync(projectFile)
    ? readFileSync(projectFile, "utf8").trim()
    : ""
  const branch =
    git("branch", "--show-current") ||
    `detached-${git("rev-parse", "--short", "HEAD")}`
  const slug =
    branch
      .replace(/^[^/]+\//u, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48)
      .replace(/-+$/u, "") || "dev"
  const name = override || saved || (primaryWorktree ? "kiln" : `kiln-${slug}`)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) {
    fail(
      "KILN_DEV_PROJECT must be 1–63 lowercase letters, digits, or hyphens, starting with a letter or digit."
    )
  }
  if (override && saved && override !== saved) {
    fail(
      `This worktree already uses ${saved}. Stop its stack and remove ${projectFile} before choosing another project.`
    )
  }
  return name
}

function developmentNetwork() {
  const configured = process.env.KILN_DEV_NETWORK?.trim() || "auto"
  if (configured === "localhost" || configured === "orbstack") return configured
  if (configured !== "auto")
    fail("KILN_DEV_NETWORK must be auto, localhost, or orbstack.")
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.OperatingSystem}}"],
    {
      cwd: worktreeRoot,
      encoding: "utf8",
      env: process.env,
    }
  )
  return result.status === 0 && /orbstack/iu.test(result.stdout)
    ? "orbstack"
    : "localhost"
}

function developmentPort(name, fallback) {
  const value = process.env[name]?.trim() || String(fallback)
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) {
    fail(`${name} must be a TCP port between 1 and 65535.`)
  }
  return Number(value)
}

function requireProjectOwnership() {
  const owners = capture("docker", [
    "container",
    "ls",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${stack}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ])
    .split("\n")
    .filter(Boolean)
  if (owners.some((owner) => resolve(owner) !== resolve(worktreeRoot))) {
    fail(
      `Docker project ${stack} belongs to another checkout. Set a unique KILN_DEV_PROJECT before starting this worktree.`
    )
  }
}

function git(...arguments_) {
  return capture("git", arguments_)
}

function capture(executable, arguments_, environment = process.env) {
  return captureAt(worktreeRoot, executable, arguments_, environment)
}

function captureAt(
  workingDirectory,
  executable,
  arguments_,
  environment = process.env
) {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: environment,
  })
  if (result.status !== 0) {
    if (result.error) fail(`${executable}: ${result.error.message}`)
    process.stderr.write(result.stderr ?? "")
    fail(`${executable} ${arguments_.join(" ")} failed.`)
  }
  return result.stdout.trim()
}

function run(executable, arguments_, environment, cwd = worktreeRoot) {
  const result = spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    stdio: "inherit",
  })
  if (result.error) fail(`${executable}: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
