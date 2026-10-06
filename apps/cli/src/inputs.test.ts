import { describe, expect, it } from "vite-plus/test"
import { MINIMUM_INSTANCE_DISK_LIMIT_BYTES } from "@workspace/contracts"

import {
  parseDiskBytes,
  parseMemoryVariable,
  parseVariableAssignments,
  remoteFileBasename,
} from "./inputs.js"

describe("CLI startup inputs", () => {
  it("parses explicit decimal and binary disk units", () => {
    expect(parseDiskBytes("25GiB")).toBe(25 * 1_024 ** 3)
    expect(parseDiskBytes("10GB")).toBe(10 * 1_000 ** 3)
    expect(parseDiskBytes("0.1GiB")).toBe(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
    expect(() => parseDiskBytes("25")).toThrow("positive size with a unit")
    expect(() => parseDiskBytes("100MiB")).toThrow("at least 0.1GiB")
  })

  it("normalizes memory for Brick variables", () => {
    expect(parseMemoryVariable("4GiB")).toBe("4G")
    expect(parseMemoryVariable("4096MiB")).toBe("4096M")
    expect(() => parseMemoryVariable("4GB")).toThrow("whole mebibytes")
  })

  it("keeps ordinary values as strings and supports explicit JSON scalars", () => {
    expect(
      parseVariableAssignments([
        "version=1.21.11",
        "debug=json:true",
        "slots=json:20",
      ])
    ).toEqual({ version: "1.21.11", debug: true, slots: 20 })
    expect(() => parseVariableAssignments(["bad name=value"])).toThrow(
      "name=value"
    )
  })
})

describe("CLI remote upload inputs", () => {
  it("derives a decoded URL basename and rejects invalid paths", () => {
    expect(
      remoteFileBasename("https://example.com/plugins/My%20Plugin.jar")
    ).toBe("My Plugin.jar")
    expect(remoteFileBasename("https://example.com/")).toBe(null)
    expect(remoteFileBasename("not-a-url")).toBe(null)
  })
})
