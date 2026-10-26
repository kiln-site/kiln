import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Node strips the schema's types, so the files are checked against the same
// definition kiln.site's creator validates with.
import {
  brickV2CatalogSchema,
  brickV2Schema,
} from "../../../packages/contracts/src/brick-v2.ts"
import { validateBrickIconSvg } from "../../../packages/contracts/src/brick-icons.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const loadJson = async (path) =>
  JSON.parse(await readFile(join(root, path), "utf8"))

async function brickFiles(directory) {
  const entries = await readdir(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath.slice(root.length + 1), entry.name))
    .sort((left, right) => left.localeCompare(right))
}

function parsed(schema, value, path) {
  const result = schema.safeParse(value)
  assert.equal(
    result.success,
    true,
    `${path}: ${result.error?.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`
  )
  return result.data
}

test("the v2 catalog lists every official Brick, and each one is valid", async () => {
  const catalog = parsed(
    brickV2CatalogSchema,
    await loadJson("catalog.json"),
    "catalog.json"
  )
  assert.deepEqual(
    [...catalog.bricks].sort((left, right) => left.localeCompare(right)),
    await brickFiles("bricks")
  )

  const ids = new Set()
  const files = [...catalog.bricks, ...(await brickFiles("community"))]
  for (const path of files) {
    const brick = parsed(brickV2Schema, await loadJson(path), path)
    assert.equal(
      `${brick.id}.json`,
      path.split("/").at(-1),
      `${path}: name the file after the Brick's id`
    )
    assert.equal(ids.has(brick.id), false, `${path}: duplicate id ${brick.id}`)
    ids.add(brick.id)
    if (brick.icon) {
      const svg = await readFile(join(root, dirname(path), brick.icon), "utf8")
      assert.doesNotThrow(() => validateBrickIconSvg(svg), `${path}: icon`)
    }
  }
})

test("a Brick can't read a value it doesn't declare", () => {
  const brick = {
    format: "kiln.brick/v2",
    id: "example",
    name: "Example",
    kind: "app",
    summary: "An example.",
    author: "Kiln",
    inputs: [{ key: "tag", label: "Tag", type: "text", default: "1" }],
    deploy: { type: "image", image: "example:{{ tag }}" },
  }
  assert.equal(brickV2Schema.safeParse(brick).success, true)
  for (const env of [{ TOKEN: "{{ secret }}" }, { TOKEN: "{{ kiln.root }}" }]) {
    assert.equal(
      brickV2Schema.safeParse({ ...brick, deploy: { ...brick.deploy, env } })
        .success,
      false
    )
  }
})
