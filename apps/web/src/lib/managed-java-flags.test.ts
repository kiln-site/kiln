import { describe, expect, it } from "vite-plus/test"

import {
  dockerMemoryBytes,
  managedJavaStartupFlags,
} from "./managed-java-flags.js"

const paperEnv = {
  KILN_ARTIFACT_FILE: "{{ variables.server_jar_file }}",
  KILN_JAVA_MAX_RAM_PERCENTAGE: "75.0",
  MIN_RAM: "512M",
}

describe("managed Java startup flags", () => {
  it("shows a 75% heap from container memory and --nogui", () => {
    expect(
      managedJavaStartupFlags(paperEnv, "2G", {
        server_jar_file: "paper.jar",
      })
    ).toBe("-Xms512M -Xmx1536M -jar paper.jar --nogui")
    expect(
      managedJavaStartupFlags(paperEnv, "4G", {
        server_jar_file: "custom.jar",
      })
    ).toBe("-Xms512M -Xmx3G -jar custom.jar --nogui")
  })

  it("omits --nogui when the recipe clears server arguments", () => {
    expect(
      managedJavaStartupFlags({ ...paperEnv, KILN_SERVER_ARGS: "" }, "1G", {
        server_jar_file: "paper.jar",
      })
    ).toBe("-Xms512M -Xmx768M -jar paper.jar")
  })

  it("uses MAX_RAM when the recipe pins an explicit heap", () => {
    expect(
      managedJavaStartupFlags({ ...paperEnv, MAX_RAM: "1800M" }, "4G", {
        server_jar_file: "paper.jar",
      })
    ).toBe("-Xms512M -Xmx1800M -jar paper.jar --nogui")
  })

  it("falls back to MaxRAMPercentage when memory is not a Docker size", () => {
    expect(
      managedJavaStartupFlags(paperEnv, "plenty", {
        server_jar_file: "paper.jar",
      })
    ).toBe("-Xms512M -XX:MaxRAMPercentage=75 -jar paper.jar --nogui")
  })

  it("parses Docker memory amounts", () => {
    expect(dockerMemoryBytes("2G")).toBe(2 * 1024 ** 3)
    expect(dockerMemoryBytes("512M")).toBe(512 * 1024 ** 2)
    expect(dockerMemoryBytes("nope")).toBeNull()
  })

  it("resolves Brick templates in managed flag environment values", () => {
    expect(
      managedJavaStartupFlags(
        {
          MIN_RAM: "{{ variables.min_memory }}",
          MAX_RAM: "{{ variables.max_memory }}",
          KILN_SERVER_ARGS: "{{ variables.extra_args }}",
        },
        "4G",
        { min_memory: "768M", max_memory: "1800M", extra_args: "--nogui" }
      )
    ).toBe("-Xms768M -Xmx1800M --nogui")
    expect(
      managedJavaStartupFlags(
        {
          MIN_RAM: "{{ variables.min_memory }}",
          KILN_JAVA_MAX_RAM_PERCENTAGE: "{{ variables.heap_percent }}",
        },
        "2G",
        { min_memory: "512M", heap_percent: "50" }
      )
    ).toBe("-Xms512M -Xmx1G --nogui")
  })
})
