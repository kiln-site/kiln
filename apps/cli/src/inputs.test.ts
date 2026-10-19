import { describe, expect, it } from "vite-plus/test"
import { MINIMUM_INSTANCE_DISK_LIMIT_BYTES } from "@workspace/contracts"

import {
  parseCpuMillis,
  parseDiskBytes,
  parseMemoryBytes,
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
    expect(parseDiskBytes("none")).toBe(null)
  })

  it("parses memory and CPU limits, or none", () => {
    expect(parseMemoryBytes("4GiB")).toBe(4 * 1_024 ** 3)
    expect(parseMemoryBytes("4096M")).toBe(4 * 1_024 ** 3)
    expect(parseMemoryBytes("none")).toBe(null)
    expect(() => parseMemoryBytes("32MiB")).toThrow("at least 64MiB")
    expect(parseCpuMillis("1.5")).toBe(1_500)
    expect(parseCpuMillis("none")).toBe(null)
    expect(() => parseCpuMillis("0.01")).toThrow("at least 0.1")
    expect(() => parseCpuMillis("two")).toThrow("number of cores")
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
