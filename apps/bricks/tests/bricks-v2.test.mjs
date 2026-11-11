import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { parse } from "yaml"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const loadJson = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"))
const loadYaml = async (path) =>
  parse(await readFile(join(root, path), "utf8"), {
    maxAliasCount: 20,
    prettyErrors: true,
    uniqueKeys: true,
  })

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validateCatalog = ajv.compile(
  await loadJson("schema/catalog-v1.schema.json")
)
// Generated from the contract Kiln reads Bricks with
// (`packages/contracts/src/brick-recipe.ts`), which also checks what a JSON
// Schema can't say: templates, and which sections a kind and type have.
const validateBrick = ajv.compile(await loadJson("schema/brick-v2.schema.json"))

const input = (brick, key) => brick.inputs?.find((item) => item.key === key)

test("the official catalog lists every v2 Brick, and each fits the format", async () => {
  const catalog = await loadYaml("bricks.yml")
  assert.equal(
    validateCatalog(catalog),
    true,
    ajv.errorsText(validateCatalog.errors)
  )
  const files = (await readdir(join(root, "bricks")))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `bricks/${name}`)
    .sort((left, right) => left.localeCompare(right))
  assert.deepEqual(
    [...catalog.recipes].sort((left, right) => left.localeCompare(right)),
    files
  )

  const ids = new Set()
  for (const path of catalog.recipes) {
    const brick = await loadYaml(path)
    assert.equal(
      validateBrick(brick),
      true,
      `${path}: ${ajv.errorsText(validateBrick.errors)}`
    )
    assert.equal(ids.has(brick.metadata.id), false, `${path}: duplicate ID`)
    ids.add(brick.metadata.id)
    const marker = brick.deploy.env?.KILN_INSTALLATION_MARKER
    if (marker) assert.match(marker, /^\.kiln-[a-zA-Z0-9._-]{1,58}$/u)
  }
})

// The Java Ember sizes the heap from the container's limit and builds the
// start command itself, so a Brick must not let an answer override either.
test("Java Bricks keep heap sizing and the start command to the Ember", async () => {
  const catalog = await loadYaml("bricks.yml")
  for (const path of catalog.recipes) {
    const brick = await loadYaml(path)
    if (!brick.deploy.image?.includes("bricks-java:")) continue
    const jar = input(brick, "server_jar_file")
    assert.equal(jar?.type, "text", `${path}: needs server_jar_file`)
    assert.equal(brick.deploy.env.KILN_ARTIFACT_FILE, "{{ server_jar_file }}")
    const jarPattern = new RegExp(jar.pattern, "u")
    assert.equal(jarPattern.test(jar.default), true)
    assert.equal(jarPattern.test("../server.jar"), false, `${path}: jar path`)

    const args = input(brick, "java_args")
    assert.equal(args?.type, "text", `${path}: needs java_args`)
    assert.equal(brick.deploy.env.KILN_JAVA_ARGS, "{{ java_args }}")
    const argsPattern = new RegExp(args.pattern, "u")
    assert.equal(argsPattern.test(args.default), true, `${path}: default`)
    assert.equal(argsPattern.test("-Dcontact=ops@example.com"), true)
    for (const refused of [
      "-Xmx2G",
      "-XX:MaxRAMPercentage=90",
      "-XX:+UseG1GC @flags.txt",
      "-XX:VMOptionsFile=/server/flags.txt",
      "-XX:-UseContainerSupport",
      "--nogui",
      "-jar other.jar",
    ]) {
      assert.equal(argsPattern.test(refused), false, `${path}: ${refused}`)
    }
  }
})
