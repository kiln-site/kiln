import { createHash, randomBytes } from "node:crypto"
import { lookup } from "node:dns/promises"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, networkInterfaces } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import {
  cacheNamespace,
  grantPattern,
  isReservedProject,
  sqlIdentifier,
  sqlString,
  stackResources,
  withBoxLock,
  withStackLock,
} from "./dev-shared.mjs"

// Raise with `io.kiln.dev.shared.version` in compose.dev.shared.yaml.
const SHARED_VERSION = "1"
const MYSQL_CONTAINER = "kiln-dev-mysql"
const CACHE_CONTAINER = "kiln-dev-cache"
const MYSQL_VOLUME = "kiln-dev-mysql"
const SHARED_PROJECT = "kiln-dev-shared"
const RCLONE_IMAGE = "rclone/rclone:1.74"
// Credentials stay on the box running the endpoint, not in this checkout.
const s3File = join(homedir(), ".config", "kiln-dev", "s3.env")
const S3_PORT = "8480"
const S3_LOCAL_PORT = "9100"
const S3_BUCKET = "kiln-dev"

// Rows on the MySQL they describe, so they can't disagree with it about what
// exists. Everything teardown deletes is named here, never guessed from a
// pattern.
const REGISTRY = `
CREATE DATABASE IF NOT EXISTS kiln_dev;
CREATE TABLE IF NOT EXISTS kiln_dev.stacks (
  stack VARCHAR(63) NOT NULL PRIMARY KEY,
  app_database VARCHAR(64) NOT NULL,
  app_user VARCHAR(32) NOT NULL,
  test_database VARCHAR(64) NOT NULL,
  checkout VARCHAR(1024) NOT NULL,
  state ENUM('provisioning', 'ready', 'destroying') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`

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
// Not 3306, which a stack from before shared services may still hold.
const mysqlPort = developmentPort("KILN_DEV_MYSQL_PORT", 3307)
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
const sharedComposeFile = resolve(worktreeRoot, "compose.dev.shared.yaml")
const resources = stackResources(stack)

if (command === "setup") {
  setupEnvironment()
  ensureSharedStore()
  console.log(`Development environment is ready at ${environmentFile}`)
  process.exit(0)
}

requireEnvironment()
const settings = parseEnvironment(readFileSync(environmentFile, "utf8"))
if (["start", "up", "down", "destroy", "refresh"].includes(command)) {
  requireProjectOwnership()
}
if (["start", "up", "refresh"].includes(command)) {
  refuseLegacyStack()
}
if (["start", "up", "refresh"].includes(command)) {
  writeFileSync(projectFile, `${stack}\n`)
}
if (command === "start" || command === "up" || command === "refresh") {
  ensureSharedStore()
}

const composeEnvironment = {
  ...process.env,
  CACHE_HOST: CACHE_CONTAINER,
  CACHE_PASSWORD: "",
  CACHE_PORT: "6379",
  CACHE_TLS: "false",
  CACHE_USERNAME: "",
  DB_NAME: resources.database,
  DB_PORT: "3306",
  DB_USERNAME: resources.user,
  KILN_DEV_ENV_FILE: environmentFile,
  KILN_DEV_WEB_PORT: String(webPort),
  KILN_DEV_MYSQL_PORT: String(mysqlPort),
  KILN_DEV_SFTP_PORT: String(sftpPort),
  KILN_INSTALLATION_ID: stack,
  KILN_RELAY_PLATFORM_DATABASE_CONTAINER: MYSQL_CONTAINER,
  KILN_RELAY_PLATFORM_DATABASE_NAME: resources.database,
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
    // Released before following it, so `refresh` works from another shell.
    await withStackLock(stack, prepareStack)
    printStack()
    compose(["up", "hearth"], composeEnvironment)
    break
  case "up":
    await withStackLock(stack, async () => {
      await prepareStack()
      printStack()
      compose(["up", "--detach", "--wait", "hearth"], composeEnvironment)
    })
    warnOutsideSlice(stackContainers())
    console.log("\nDevelopment stack is ready.")
    break
  case "down":
    compose(["down"], composeEnvironment)
    break
  case "destroy":
    await withStackLock(stack, destroy)
    break
  case "logs":
    compose(["logs", "--follow", "hearth", "relay"], composeEnvironment)
    break
  case "refresh":
    await withStackLock(stack, refresh)
    break
  case "url":
    console.log(hearthUrl)
    break
  case "test":
    await test()
    break
  case "list":
    run("docker", ["compose", "ls"], process.env)
    break
  case "shared":
    await shared(process.argv[3] ?? "status", process.argv.slice(4))
    break
  case "s3":
    s3(process.argv[3] ?? "status")
    break
  default:
    fail(`Unknown development Docker command: ${command}`)
}

// Web tests, including the real-MySQL suites, on the box's MySQL. They run as
// this stack's user, which can make its own test databases and no others, and
// which destroy drops, so a run can't bring them back afterwards.
async function test() {
  await withStackLock(stack, () =>
    withBoxLock(() => {
      ensureShared()
      provisionStack()
    })
  )
  run(
    process.execPath,
    [
      resolve(worktreeRoot, "scripts/verify.mjs"),
      "hearth",
      ...process.argv.slice(3),
    ],
    {
      ...process.env,
      KILN_TEST_MYSQL: "1",
      DB_HOST: "127.0.0.1",
      DB_PORT: publishedMysqlPort(),
      DB_NAME: resources.testDatabase,
      DB_USERNAME: resources.user,
      DB_PASSWORD: settings.get("DB_PASSWORD"),
    },
    worktreeRoot
  )
}

// Reads where the box's MySQL is published, which is what the checkout that
// started it chose.
function publishedMysqlPort() {
  const published = capture("docker", ["port", MYSQL_CONTAINER, "3306/tcp"])
  return published.split("\n")[0]?.split(":").pop() ?? String(mysqlPort)
}

async function prepareStack() {
  const s3Environment = await resolveS3Host()
  Object.assign(composeEnvironment, s3Environment)
  await withBoxLock(() => {
    ensureShared()
    provisionStack()
  })
  warnOutsideSlice([MYSQL_CONTAINER, CACHE_CONTAINER])
}

// Containers on a box without tailnet DNS can't resolve the S3 endpoint's
// name themselves, so they get what this host resolves it to.
async function resolveS3Host() {
  const endpoint = settings.get("KILN_DEV_S3_ENDPOINT")
  if (!endpoint) return {}
  const host = new URL(endpoint).hostname
  try {
    const { address } = await lookup(host, { family: 4 })
    return {
      KILN_DEV_S3_ADDRESS: isThisBox(address) ? "host-gateway" : address,
      KILN_DEV_S3_HOST: host,
    }
  } catch {
    console.warn(`Could not resolve ${host}; backups to it won't work here.`)
    return {}
  }
}

// The endpoint's own box answers on its tailnet address only to host
// processes, so its containers use the forwarder on Docker's gateway.
function isThisBox(address) {
  return Object.values(networkInterfaces())
    .flat()
    .some((entry) => entry?.address === address)
}

function refuseLegacyStack() {
  if (!volumeExists(`${stack}_hearth-mysql`)) return
  fail(
    `Stack ${stack} keeps its data in its own MySQL, from before shared services, which this revision can't run. Run pnpm dev:docker:destroy to delete it and start fresh, or stay on an older revision to keep it.`
  )
}

// False only when Docker says there's no such volume: teardown reads that as
// proof nothing is registered, which a failed lookup isn't.
function volumeExists(name) {
  const result = spawnSync("docker", ["volume", "inspect", name], {
    cwd: worktreeRoot,
    encoding: "utf8",
    env: process.env,
  })
  if (result.status === 0) return true
  if (/no such volume/iu.test(result.stderr ?? "")) return false
  process.stderr.write(result.stderr ?? "")
  fail(`Could not tell whether Docker volume ${name} exists.`)
}

function composeShared(arguments_) {
  run(
    "docker",
    [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      SHARED_PROJECT,
      "--file",
      sharedComposeFile,
      ...arguments_,
    ],
    {
      ...process.env,
      KILN_DEV_MYSQL_PORT: String(mysqlPort),
    }
  )
}

function sharedContainerState(container) {
  const result = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{index .Config.Labels "io.kiln.dev.shared.version"}}',
      container,
    ],
    { cwd: worktreeRoot, encoding: "utf8", env: process.env }
  )
  if (result.status !== 0) return null
  const [status, health, version] = result.stdout.trim().split("|")
  return { health, status, version }
}

// Leaves healthy services alone: they carry every other stack on the box, and
// this checkout may be on another revision. Call with the box lock held.
function ensureShared() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const states = [MYSQL_CONTAINER, CACHE_CONTAINER].map(sharedContainerState)
    const present = states.filter(Boolean)
    for (const state of present) {
      if (state.version !== SHARED_VERSION) {
        fail(
          `The box's shared services are version ${state.version || "unknown"}, and this checkout needs ${SHARED_VERSION}. Run pnpm dev:docker:shared up --recreate when no stack is busy; their data stays.`
        )
      }
    }
    if (
      present.length === 2 &&
      present.every((state) => state.health === "healthy")
    ) {
      return
    }
    if (present.some((state) => state.health === "unhealthy")) {
      fail(
        "The box's shared services are unhealthy. See pnpm dev:docker:shared status and their logs; they aren't recreated automatically."
      )
    }
    if (present.some((state) => state.health === "starting")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
      continue
    }
    composeShared(["up", "--detach", "--wait", "--no-recreate"])
  }
  fail("Timed out waiting for the box's shared services.")
}

function mysql(statements) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--interactive",
      "--env",
      "MYSQL_PWD=kiln-root",
      MYSQL_CONTAINER,
      "mysql",
      "--user=root",
      "--batch",
      "--skip-column-names",
    ],
    {
      cwd: worktreeRoot,
      encoding: "utf8",
      env: process.env,
      input: statements,
    }
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    fail("A statement on the box's MySQL failed.")
  }
  return result.stdout.trim()
}

function parseRegistryRow(line) {
  const [name, database, user, testDatabase, checkout, state] = line.split("\t")
  return { checkout, database, name, state, testDatabase, user }
}

function registryRows() {
  const rows = mysql(`${REGISTRY}
    SELECT stack, app_database, app_user, test_database, checkout, state
    FROM kiln_dev.stacks ORDER BY stack;`)
  return rows ? rows.split("\n").map(parseRegistryRow) : []
}

function registryRow(name) {
  return registryRows().find((row) => row.name === name) ?? null
}

// Reserves the stack before making anything, so a stop halfway leaves an
// owner to resume it, and never takes over what it didn't make. Call with the
// box lock held.
function provisionStack() {
  const checkout = resolve(worktreeRoot)
  const row = registryRow(stack)
  if (row?.state === "destroying") {
    fail(
      `Stack ${stack} is being destroyed. Finish with pnpm dev:docker:destroy.`
    )
  }
  if (row && row.checkout !== checkout) {
    fail(
      `Stack ${stack} belongs to ${row.checkout}. Destroy it there, or run pnpm dev:docker:shared remove ${stack} if that checkout is gone.`
    )
  }
  if (!row) {
    const existing = mysql(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = ${sqlString(resources.database)}
        OR schema_name LIKE ${sqlString(testDatabasesLike(resources.testDatabase))};
      SELECT user FROM mysql.user WHERE user = ${sqlString(resources.user)};`)
    if (existing) {
      fail(
        `${existing.split("\n").join(" and ")} already exist on the box's MySQL with no registered stack; refusing to adopt them.`
      )
    }
    mysql(`INSERT INTO kiln_dev.stacks
      (stack, app_database, app_user, test_database, checkout, state)
      VALUES (${[stack, resources.database, resources.user, resources.testDatabase, checkout, "provisioning"].map(sqlString).join(", ")});`)
  }
  const user = `${sqlString(resources.user)}@'%'`
  const password = sqlString(settings.get("DB_PASSWORD"))
  mysql(`
    CREATE DATABASE IF NOT EXISTS \`${resources.database}\`;
    CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${password};
    ALTER USER ${user} IDENTIFIED BY ${password};
    GRANT ALL ON \`${grantPattern(resources.database)}\`.* TO ${user};
    GRANT ALL ON \`${grantPattern(resources.testDatabase)}%\`.* TO ${user};
    UPDATE kiln_dev.stacks SET state = 'ready'
    WHERE stack = ${sqlString(stack)};`)
}

function testDatabasesLike(testDatabase) {
  return `${grantPattern(testDatabase)}%`
}

function waitBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
}

// Locks the user out, then ends its sessions, and only then deletes: dropping
// a user leaves its connections running, and one that got in late could
// recreate what follows. Deletes what the row names and nothing else.
function dropStackData(row) {
  const user = `${sqlString(row.user)}@'%'`
  mysql(`ALTER USER IF EXISTS ${user} ACCOUNT LOCK;`)
  endSessions(row.user)
  const databases = mysql(`
    SELECT HEX(schema_name) FROM information_schema.schemata
    WHERE schema_name = ${sqlString(row.database)}
      OR schema_name LIKE ${sqlString(testDatabasesLike(row.testDatabase))};`)
  const drops = databases
    .split("\n")
    .filter(Boolean)
    .map((hex) => Buffer.from(hex, "hex").toString("utf8"))
    .map((name) => `DROP DATABASE IF EXISTS ${sqlIdentifier(name)};`)
  if (drops.length > 0) mysql(drops.join("\n"))
  mysql(`DROP USER IF EXISTS ${user};`)
  dropCacheKeys(row.database)
}

function endSessions(user) {
  const NO_SUCH_THREAD = "ERROR 1094"
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessions = mysql(`
      SELECT id FROM information_schema.processlist
      WHERE user = ${sqlString(user)};`)
      .split("\n")
      .filter(Boolean)
    if (sessions.length === 0) return
    for (const session of sessions) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--interactive",
          "--env",
          "MYSQL_PWD=kiln-root",
          MYSQL_CONTAINER,
          "mysql",
          "--user=root",
        ],
        {
          cwd: worktreeRoot,
          encoding: "utf8",
          env: process.env,
          input: `KILL ${Number(session)};`,
        }
      )
      // A session may end by itself first.
      if (result.status !== 0 && !result.stderr?.includes(NO_SUCH_THREAD)) {
        process.stderr.write(result.stderr ?? "")
        fail(`Could not end session ${session} of ${user}.`)
      }
    }
    waitBriefly()
  }
  fail(`Sessions of ${user} are still running.`)
}

function dropCacheKeys(database) {
  const state = sharedContainerState(CACHE_CONTAINER)
  // Its keys live in memory, so a stopped cache has none.
  if (state?.status !== "running") return
  const namespace = cacheNamespace({
    database,
    host: MYSQL_CONTAINER,
    port: 3306,
    tablePrefix: settings.get("DB_TABLE_PREFIX")?.trim() || "kiln_",
  })
  const script =
    "local c='0' repeat local r=redis.call('SCAN',c,'MATCH',ARGV[1],'COUNT',1000) c=r[1] for _,k in ipairs(r[2]) do redis.call('UNLINK',k) end until c=='0'"
  run(
    "docker",
    [
      "exec",
      CACHE_CONTAINER,
      "sh",
      "-ec",
      'cli=$(command -v valkey-cli || command -v redis-cli); exec "$cli" -n "$0" EVAL "$1" 0 "$2"',
      settings.get("CACHE_DATABASE")?.trim() || "0",
      script,
      `${namespace}:*`,
    ],
    process.env
  )
}

// A stack's backups on the tailnet S3 endpoint, under the object prefix its
// destination uses. Returns whether none are left.
function purgeS3Prefix(name) {
  const endpoint = settings.get("KILN_DEV_S3_ENDPOINT")
  if (!endpoint) return true
  const bucket = settings.get("KILN_DEV_S3_BUCKET") || "kiln-dev"
  const prefix = [settings.get("KILN_DEV_S3_PREFIX"), "kiln", name]
    .filter(Boolean)
    .join("/")
  const host = composeEnvironment.KILN_DEV_S3_HOST
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      ...(host
        ? ["--add-host", `${host}:${composeEnvironment.KILN_DEV_S3_ADDRESS}`]
        : []),
      "--env",
      "RCLONE_CONFIG_S3_TYPE=s3",
      "--env",
      "RCLONE_CONFIG_S3_PROVIDER=Other",
      "--env",
      `RCLONE_CONFIG_S3_ENDPOINT=${endpoint}`,
      "--env",
      "RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true",
      "--env",
      "RCLONE_CONFIG_S3_ACCESS_KEY_ID",
      "--env",
      "RCLONE_CONFIG_S3_SECRET_ACCESS_KEY",
      RCLONE_IMAGE,
      "--retries",
      "2",
      "delete",
      `s3:${bucket}/${prefix}`,
    ],
    {
      cwd: worktreeRoot,
      env: {
        ...process.env,
        RCLONE_CONFIG_S3_ACCESS_KEY_ID: settings.get("KILN_DEV_S3_ACCESS_KEY"),
        RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: settings.get(
          "KILN_DEV_S3_SECRET_KEY"
        ),
      },
      stdio: "inherit",
    }
  )
  if (result.status === 0) return true
  console.error(`Could not purge s3://${bucket}/${prefix}.`)
  return false
}

function removeVolumes(label) {
  const volumes = capture("docker", [
    "volume",
    "ls",
    "--filter",
    `label=${label}`,
    "--format",
    "{{.Name}}",
  ])
    .split("\n")
    .filter(Boolean)
  if (volumes.length > 0) {
    run("docker", ["volume", "remove", ...volumes], process.env)
  }
}

// Stops what writes first and clears the registry row last, so any step that
// fails leaves a rerun everything it needs to finish.
async function destroy() {
  const primary = process.argv.includes("--primary")
  if (primary && namespace)
    fail("--primary only applies to the primary checkout.")
  if (!primary) requireNamespaceForDestroy()
  if (primary) refuseUnscopedWorkloads()

  let row = null
  await withBoxLock(() => {
    // With no volume there's no registry, so no row to lose. Otherwise a
    // MySQL that can't answer stops here, before anything is deleted.
    if (!volumeExists(MYSQL_VOLUME)) return
    ensureShared()
    row = registryRow(stack)
    if (row && row.checkout !== resolve(worktreeRoot)) {
      fail(`Stack ${stack} belongs to ${row.checkout}. Destroy it there.`)
    }
    if (row) {
      mysql(`UPDATE kiln_dev.stacks SET state = 'destroying'
        WHERE stack = ${sqlString(stack)};`)
    }
  })
  const unfinished = (code) => {
    if (code !== 0 && row) {
      console.error(
        `Stack ${stack} isn't fully destroyed. Run pnpm dev:docker:destroy again to finish.`
      )
    }
  }
  process.on("exit", unfinished)

  Object.assign(composeEnvironment, await resolveS3Host())
  compose(["stop"], composeEnvironment)
  if (namespace) destroyNamespacedContainers()
  compose(["down"], composeEnvironment)
  if (namespace) destroyNamespacedNetworks()
  const purged = purgeS3Prefix(stack)
  if (row) await withBoxLock(() => dropStackData(row))
  compose(["down", "--volumes", "--remove-orphans"], composeEnvironment)
  removeVolumes(`com.docker.compose.project=${stack}`)
  if (namespace) removeVolumes(`kiln.relay.owner=${namespace}`)
  if (!purged) process.exit(1)
  if (row) {
    await withBoxLock(() => {
      mysql(`DELETE FROM kiln_dev.stacks WHERE stack = ${sqlString(stack)};`)
    })
  }
  if (primary) {
    console.log(
      "The primary stack's data is gone. Its Relay's unscoped Docker resources were left alone."
    )
  }
}

// Unscoped workloads can only be managed through the Relay data this deletes,
// and may be another Relay's on the same box.
function refuseUnscopedWorkloads() {
  const unscoped = capture("docker", [
    "container",
    "ls",
    "--all",
    "--filter",
    "label=kiln.relay.managed=true",
    "--format",
    '{{.Names}}\t{{.Label "kiln.relay.owner"}}',
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, owner]) => !owner)
    .map(([name]) => name)
  if (unscoped.length > 0) {
    fail(
      `Refusing to delete the primary stack's Relay data while unscoped workloads exist, which only it may be able to manage: ${unscoped.join(", ")}.`
    )
  }
}

async function shared(action, arguments_) {
  switch (action) {
    case "up":
      await withBoxLock(() => {
        if (arguments_.includes("--recreate")) {
          composeShared(["up", "--detach", "--wait", "--force-recreate"])
        } else {
          ensureShared()
        }
      })
      break
    case "status":
      sharedStatus()
      break
    case "down":
      await withBoxLock(() => {
        const busy = runningStacks()
        if (busy.length > 0 && !arguments_.includes("--force")) {
          fail(`Stacks are using the shared services: ${busy.join(", ")}.`)
        }
        composeShared(["down"])
      })
      break
    case "destroy":
      await withBoxLock(() => {
        ensureShared()
        const rows = registryRows()
        if (rows.length > 0) {
          fail(
            `Stacks still have data here: ${rows.map((row) => row.name).join(", ")}. Destroy them first.`
          )
        }
        composeShared(["down", "--volumes", "--remove-orphans"])
      })
      break
    case "remove":
      await withStackLock(arguments_[0] ?? "", () =>
        removeOrphan(arguments_[0])
      )
      break
    default:
      fail("Usage: pnpm dev:docker:shared <status|up|down|destroy|remove>")
  }
}

// Stacks from before shared services run too, with their own MySQL.
function runningStacks() {
  const registered = new Set(registryRows().map((row) => row.name))
  return capture("docker", [
    "container",
    "ls",
    "--filter",
    "label=io.kiln.resource=hearth",
    "--format",
    '{{.Label "com.docker.compose.project"}}',
  ])
    .split("\n")
    .filter((name) => registered.has(name))
}

// For a stack whose checkout was removed without destroying it.
async function removeOrphan(name) {
  if (!name) fail("Usage: pnpm dev:docker:shared remove <stack>")
  let row = null
  await withBoxLock(() => {
    ensureShared()
    row = registryRow(name)
    if (!row) fail(`No stack named ${name} is registered here.`)
    if (existsSync(row.checkout)) {
      fail(`${row.checkout} still exists. Run pnpm dev:docker:destroy there.`)
    }
    const containers = capture("docker", [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${name}`,
      "--format",
      "{{.Names}}",
    ])
    if (containers) {
      fail(`Remove ${name}'s containers first:\n${containers}`)
    }
    mysql(`UPDATE kiln_dev.stacks SET state = 'destroying'
      WHERE stack = ${sqlString(name)};`)
  })
  Object.assign(composeEnvironment, await resolveS3Host())
  const purged = purgeS3Prefix(name)
  await withBoxLock(() => dropStackData(row))
  removeVolumes(`com.docker.compose.project=${name}`)
  removeVolumes(`kiln.relay.owner=${name}`)
  if (!purged) process.exit(1)
  await withBoxLock(() => {
    mysql(`DELETE FROM kiln_dev.stacks WHERE stack = ${sqlString(name)};`)
  })
}

function sharedStatus() {
  for (const container of [MYSQL_CONTAINER, CACHE_CONTAINER]) {
    const state = sharedContainerState(container)
    console.log(
      state
        ? `${container}: ${state.status}${state.health ? ` (${state.health})` : ""}, version ${state.version}, ${placement(container) ?? "cgroup unknown"}`
        : `${container}: absent`
    )
  }
  if (sharedContainerState(MYSQL_CONTAINER)?.health !== "healthy") return
  const rows = registryRows()
  const sizes = new Map(
    mysql(`
      SELECT table_schema, ROUND(SUM(data_length + index_length) / 1048576)
      FROM information_schema.tables GROUP BY table_schema;`)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
  )
  console.log(`\n${rows.length} registered stack(s):`)
  for (const row of rows) {
    const gone = existsSync(row.checkout) ? "" : " (checkout gone)"
    console.log(
      `  ${row.name}: ${row.state}, ${row.database}, ${sizes.get(row.database) ?? 0} MiB, ${row.checkout}${gone}`
    )
  }
  const known = new Set(rows.map((row) => row.database))
  const owned = rows.map((row) => row.testDatabase)
  const strays = mysql(`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 's\\_%' OR schema_name LIKE 't\\_%';`)
    .split("\n")
    .filter(Boolean)
    .filter(
      (name) =>
        !known.has(name) && !owned.some((prefix) => name.startsWith(prefix))
    )
  if (strays.length > 0) {
    console.log(`\nDatabases no stack owns: ${strays.join(", ")}`)
  }
}

function s3Credentials() {
  if (!existsSync(s3File)) {
    mkdirSync(dirname(s3File), { mode: 0o700, recursive: true })
    writeFileSync(
      s3File,
      [
        `KILN_DEV_S3_ACCESS_KEY=${secret(15)}`,
        `KILN_DEV_S3_SECRET_KEY=${secret(30)}`,
        // Kept here so no later command points it at an empty volume.
        `KILN_DEV_S3_DATA=${process.env.KILN_DEV_S3_DATA?.trim() ?? ""}`,
        "",
      ].join("\n"),
      { mode: 0o600 }
    )
  }
  return parseEnvironment(readFileSync(s3File, "utf8"))
}

function tailscaleSelf() {
  const status = JSON.parse(capture("tailscale", ["status", "--json"]))
  return {
    address: status.Self.TailscaleIPs.find((ip) => ip.includes(".")),
    host: status.Self.DNSName.replace(/\.$/u, ""),
  }
}

function composeS3(arguments_) {
  const credentials = s3Credentials()
  const self = tailscaleSelf()
  run(
    "docker",
    [
      "compose",
      "--project-name",
      "kiln-dev-s3",
      "--file",
      resolve(worktreeRoot, "compose.dev.s3.yaml"),
      ...arguments_,
    ],
    {
      ...process.env,
      KILN_DEV_S3_ACCESS_KEY: credentials.get("KILN_DEV_S3_ACCESS_KEY"),
      KILN_DEV_S3_DATA: credentials.get("KILN_DEV_S3_DATA"),
      KILN_DEV_S3_BRIDGE_ADDRESS: capture("docker", [
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{(index .IPAM.Config 0).Gateway}}",
      ]),
      KILN_DEV_S3_LOCAL_PORT: S3_LOCAL_PORT,
      KILN_DEV_S3_PORT: S3_PORT,
      KILN_DEV_S3_SECRET_KEY: credentials.get("KILN_DEV_S3_SECRET_KEY"),
      KILN_DEV_S3_TAILNET_ADDRESS: self.address,
    }
  )
  return { credentials, self }
}

// The settings every box's .env needs, to paste there.
function s3Settings() {
  const credentials = s3Credentials()
  return [
    `KILN_DEV_S3_ENDPOINT=https://${tailscaleSelf().host}:${S3_PORT}`,
    `KILN_DEV_S3_BUCKET=${S3_BUCKET}`,
    `KILN_DEV_S3_ACCESS_KEY=${credentials.get("KILN_DEV_S3_ACCESS_KEY")}`,
    `KILN_DEV_S3_SECRET_KEY=${credentials.get("KILN_DEV_S3_SECRET_KEY")}`,
  ].join("\n")
}

function s3(action) {
  switch (action) {
    case "up": {
      const { credentials, self } = composeS3(["up", "--detach", "--wait"])
      run(
        "tailscale",
        [
          "serve",
          "--bg",
          `--https=${S3_PORT}`,
          `http://127.0.0.1:${S3_LOCAL_PORT}`,
        ],
        process.env
      )
      run(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "host",
          "--env",
          "RCLONE_CONFIG_S3_TYPE=s3",
          "--env",
          "RCLONE_CONFIG_S3_PROVIDER=Other",
          "--env",
          `RCLONE_CONFIG_S3_ENDPOINT=https://${self.host}:${S3_PORT}`,
          "--env",
          "RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true",
          "--env",
          "RCLONE_CONFIG_S3_ACCESS_KEY_ID",
          "--env",
          "RCLONE_CONFIG_S3_SECRET_ACCESS_KEY",
          RCLONE_IMAGE,
          "mkdir",
          `s3:${S3_BUCKET}`,
        ],
        {
          ...process.env,
          RCLONE_CONFIG_S3_ACCESS_KEY_ID: credentials.get(
            "KILN_DEV_S3_ACCESS_KEY"
          ),
          RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: credentials.get(
            "KILN_DEV_S3_SECRET_KEY"
          ),
        }
      )
      console.log(
        `\nS3 is ready. Add this to each box's .env:\n\n${s3Settings()}`
      )
      break
    }
    case "env":
      console.log(s3Settings())
      break
    case "status":
      run(
        "docker",
        [
          "container",
          "ls",
          "--all",
          "--filter",
          "label=com.docker.compose.project=kiln-dev-s3",
        ],
        process.env
      )
      run("tailscale", ["serve", "status"], process.env)
      break
    case "down":
      // Its data stays, on the volume or directory it was given.
      composeS3(["down"])
      run("tailscale", ["serve", `--https=${S3_PORT}`, "off"], process.env)
      break
    default:
      fail("Usage: pnpm dev:docker:s3 <up|status|env|down>")
  }
}

function stackContainers() {
  return captureCompose(["ps", "--quiet"], composeEnvironment)
    .split("\n")
    .filter(Boolean)
}

// The cgroup a running container's main process is in, or null where the
// Docker engine isn't on this kernel, as on macOS.
function placement(container) {
  const result = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Pid}}", container],
    { cwd: worktreeRoot, encoding: "utf8", env: process.env }
  )
  const path = `/proc/${result.stdout?.trim()}/cgroup`
  if (result.status !== 0 || !existsSync(path)) return null
  return (
    readFileSync(path, "utf8").trim().split("::").pop()?.split("/")[1] ?? null
  )
}

// Where this box keeps development containers: what KILN_DEV_CGROUP_PARENT
// names, or the slice its Docker daemon defaults to.
function warnOutsideSlice(containers) {
  const expected =
    process.env.KILN_DEV_CGROUP_PARENT?.trim() ||
    (existsSync("/etc/systemd/system/dockerbudget.slice")
      ? "dockerbudget.slice"
      : "")
  if (!expected) return
  for (const container of containers) {
    const actual = placement(container)
    if (actual && actual !== expected) {
      console.warn(`${container} is in ${actual}, not ${expected}.`)
    }
  }
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
      "Refusing to destroy unscoped Relay resources from the primary worktree. Use dev:docker:down, or dev:docker:destroy --primary to delete its data and leave those resources."
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

async function refresh() {
  await prepareStack()
  const services = ["relay", "hearth"]
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
  if (isReservedProject(name)) {
    fail(
      `${name} is the Compose project of the box's shared services, and destroying a stack under it would delete them. Set KILN_DEV_PROJECT to another name.`
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
