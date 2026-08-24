import { assert, describe, it } from "@effect/vitest"
import { formatSnbt, parseSnbt } from "@workspace/contracts"

import { decodeNbt, encodeNbt } from "./nbt.js"

describe("Minecraft NBT codec", () => {
  it("round trips every binary tag type through formatted SNBT", () => {
    const source = parseSnbt(
      `{
        byte: -12b,
        short: 32000s,
        int: 42,
        long: 9223372036854775807L,
        float: 1.25f,
        double: -2.5d,
        bytes: [B; -128b, 0b, 127b],
        string: "snowman \\u2603",
        list: [1, 2, 3],
        compound: {enabled: true},
        ints: [I; -2147483648, 2147483647],
        longs: [L; -1L, 2L]
      }`,
      { binaryCompatible: true }
    )
    const encoded = encodeNbt({ name: "Player", tag: source })
    const decoded = decodeNbt(encoded)

    assert.strictEqual(decoded.name, "Player")
    assert.deepEqual(decoded.tag, source)
    assert.deepEqual(
      parseSnbt(formatSnbt(decoded.tag), { binaryCompatible: true }),
      source
    )
  })

  it("uses Minecraft's compound wrappers for heterogeneous binary lists", () => {
    const parsed = parseSnbt(`[1, "two"]`, { binaryCompatible: true })
    assert.strictEqual(parsed.type, "list")
    if (parsed.type !== "list") return
    assert.strictEqual(parsed.elementType, "compound")
    assert.deepEqual(
      parsed.value.map((tag) => tag.type),
      ["compound", "compound"]
    )
  })

  it("reports line and column for invalid SNBT", () => {
    assert.throws(
      () => parseSnbt("{\n  Health: 20.0f,\n  Inventory: [\n}"),
      /line 4, column 1/u
    )
  })
})
