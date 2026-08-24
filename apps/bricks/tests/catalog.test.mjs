import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { parse } from "yaml"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const JAVA_ARGS_RULE_PATTERN =
  "^(?!.*(?:^|\\s)(?:@(?!@)\\S+|-Xm[sx]\\S*|-XX:(?:-UseContainerSupport|-UseCGroupMemoryLimitForHeap|InitialHeapSize|MaxHeapSize|SoftMaxHeapSize|MaxRAMPercentage|MinRAMPercentage|InitialRAMPercentage|MaxRAMFraction|InitialRAMFraction|MinRAMFraction|MaxRAM|VMOptionsFile|Flags)(?:=\\S*)?|--nogui|-jar)(?:\\s|$)).*$"
const SERVER_JAR_FILE_RULE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._\\-]{0,123}\\.jar$"
const OFFICIAL_READINESS_LOGS = {
  fabric: [")! For help, type "],
  folia: [")! For help, type "],
  palworld: ["Setting breakpad minidump AppID = 2394010"],
  paper: [")! For help, type "],
  velocity: ["Done ("],
}
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
const validateRecipe = ajv.compile(
  await loadJson("schema/recipe-v1.schema.json")
)

test("the official catalog and every recipe satisfy the v1 schemas", async () => {
  const catalog = await loadYaml("catalog.yml")
  assert.equal(
    validateCatalog(catalog),
    true,
    ajv.errorsText(validateCatalog.errors)
  )

  const recipeFiles = (await readdir(join(root, "recipes")))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `recipes/${name}`)
    .sort((left, right) => left.localeCompare(right))
  assert.deepEqual(
    [...catalog.recipes].sort((left, right) => left.localeCompare(right)),
    recipeFiles
  )

  const ids = new Set()
  for (const recipePath of catalog.recipes) {
    const recipe = await loadYaml(recipePath)
    assert.equal(
      validateRecipe(recipe),
      true,
      `${recipePath}: ${ajv.errorsText(validateRecipe.errors)}`
    )
    assert.equal(
      ids.has(recipe.metadata.id),
      false,
      `duplicate metadata.id ${recipe.metadata.id}`
    )
    ids.add(recipe.metadata.id)
    for (const [name, variable] of Object.entries(recipe.variables)) {
      if ("default" in variable) {
        assert.equal(
          typeof variable.default,
          variable.type,
          `${recipePath}: ${name}.default must match its declared type`
        )
      }
      for (const option of variable.options ?? []) {
        assert.equal(
          typeof option,
          variable.type,
          `${recipePath}: ${name}.options must match its declared type`
        )
      }
    }
    assert.equal(
      recipe.network.ports.some(
        ({ name }) => name === recipe.network.primaryPort
      ),
      true,
      `${recipePath}: primaryPort must name a declared port`
    )
    assert.equal(
      new Set(recipe.console?.stopCommands ?? []).size,
      recipe.console?.stopCommands.length ?? 0,
      `${recipePath}: console stop commands must be unique`
    )
    if (recipe.metadata.id in OFFICIAL_READINESS_LOGS) {
      assert.deepEqual(
        recipe.readiness?.logs,
        OFFICIAL_READINESS_LOGS[recipe.metadata.id],
        `${recipePath}: readiness logs must match the official startup signal`
      )
    }
    const installationMarker =
      recipe.runtime.environment.KILN_INSTALLATION_MARKER
    if (installationMarker) {
      assert.match(installationMarker, /^\.kiln-[a-zA-Z0-9._-]{1,58}$/u)
    }
    if (recipe.runtime.image.includes("bricks-java:")) {
      const javaArgs = recipe.variables.java_args
      const serverJarFile = recipe.variables.server_jar_file
      assert.equal(
        serverJarFile?.type,
        "string",
        `${recipePath}: Java recipes must declare server_jar_file`
      )
      assert.equal(
        serverJarFile?.default,
        `${recipe.metadata.id}.jar`,
        `${recipePath}: Java recipe jar filenames must default to the Brick id`
      )
      assert.equal(
        serverJarFile?.rules?.pattern,
        SERVER_JAR_FILE_RULE_PATTERN,
        `${recipePath}: Java recipe jar filenames must be safe .jar basenames`
      )
      assert.equal(
        recipe.runtime.environment.KILN_ARTIFACT_FILE,
        "{{ variables.server_jar_file }}",
        `${recipePath}: Java recipes must download and start the configured jar filename`
      )
      const serverJarFilePattern = new RegExp(
        serverJarFile?.rules?.pattern ?? "",
        "u"
      )
      assert.equal(
        serverJarFilePattern.test(serverJarFile?.default ?? ""),
        true
      )
      assert.equal(serverJarFilePattern.test("custom-server.jar"), true)
      assert.equal(serverJarFilePattern.test("../server.jar"), false)
      assert.equal(serverJarFilePattern.test("server.zip"), false)
      assert.equal(
        javaArgs?.type,
        "string",
        `${recipePath}: Java recipes must declare java_args`
      )
      assert.equal(
        recipe.runtime.environment.KILN_JAVA_ARGS,
        "{{ variables.java_args }}",
        `${recipePath}: Java recipes must map java_args to KILN_JAVA_ARGS`
      )
      assert.doesNotMatch(
        javaArgs.default ?? "",
        /(?:-Xm[sx]\b|-XX:(?:-UseContainerSupport|-UseCGroupMemoryLimitForHeap|InitialHeapSize|MaxHeapSize|SoftMaxHeapSize|MaxRAMPercentage|MinRAMPercentage|InitialRAMPercentage|MaxRAMFraction|InitialRAMFraction|MinRAMFraction|MaxRAM)\b|--nogui|-jar)/u,
        `${recipePath}: java_args defaults must omit managed heap and startup command arguments`
      )
      assert.doesNotMatch(
        javaArgs.default ?? "",
        /--add-modules=jdk\.incubator\.vector/u,
        `${recipePath}: java_args defaults must omit --add-modules=jdk.incubator.vector so Java 11 can start`
      )
      assert.equal(
        javaArgs.rules?.pattern,
        JAVA_ARGS_RULE_PATTERN,
        `${recipePath}: java_args must reject heap aliases, argument files, container-support overrides, and --nogui`
      )
      const javaArgsPattern = new RegExp(javaArgs.rules?.pattern ?? "", "u")
      assert.equal(javaArgsPattern.test(javaArgs.default ?? ""), true)
      assert.equal(javaArgsPattern.test(""), true)
      assert.equal(javaArgsPattern.test("-XX:+UseG1GC -Dkiln.test=true"), true)
      assert.equal(javaArgsPattern.test('-Dmessage="hello world"'), true)
      assert.equal(javaArgsPattern.test("-Xmx2G"), false)
      assert.equal(javaArgsPattern.test("-XX:+UseG1GC --nogui"), false)
      assert.equal(javaArgsPattern.test("-jar custom.jar"), false)
      assert.equal(javaArgsPattern.test("-XX:MaxRAMPercentage=75.0"), false)
      assert.equal(javaArgsPattern.test("-XX:MaxHeapSize=1G"), false)
      assert.equal(javaArgsPattern.test("-XX:InitialHeapSize=512M"), false)
      assert.equal(javaArgsPattern.test("-XX:MaxRAM=4G"), false)
      assert.equal(javaArgsPattern.test("-XX:MinRAMPercentage=50"), false)
      assert.equal(javaArgsPattern.test("-XX:MaxRAMFraction=2"), false)
      assert.equal(javaArgsPattern.test("@/server/flags.txt"), false)
      assert.equal(javaArgsPattern.test("-XX:+UseG1GC @flags.txt"), false)
      assert.equal(
        javaArgsPattern.test("-XX:VMOptionsFile=/server/flags.txt"),
        false
      )
      assert.equal(javaArgsPattern.test("-Dcontact=ops@example.com"), true)
      assert.equal(javaArgsPattern.test("-XX:-UseContainerSupport"), false)
      assert.equal(
        javaArgsPattern.test("-XX:+UseG1GC -XX:-UseCGroupMemoryLimitForHeap"),
        false
      )
    }
  }
})

test("installer-aware Ember images advertise the marker protocol", async () => {
  for (const path of ["embers/java/Dockerfile", "embers/steamcmd/Dockerfile"]) {
    assert.match(
      await readFile(join(root, path), "utf8"),
      /^LABEL kiln\.ember\.installation-marker="v1"$/mu,
      path
    )
  }
})

test("entrypoints pass Bash syntax validation in CI", async () => {
  const entrypoints = [
    "embers/java/entrypoint.sh",
    "embers/steamcmd/entrypoint.sh",
  ]
  for (const path of entrypoints) {
    assert.match(
      await readFile(join(root, path), "utf8"),
      /^#!\/usr\/bin\/env bash/u
    )
  }
})
