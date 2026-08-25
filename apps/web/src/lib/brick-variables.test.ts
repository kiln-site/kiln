import { describe, expect, it } from "vite-plus/test"
import {
  brickRecipeSchema,
  requiredMinecraftJavaVersion,
} from "@workspace/contracts"

import {
  defaultBrickVariables,
  defaultBrickRuntimeName,
  hydrateBrickVariables,
  missingRequiredBrickVersion,
  recommendedSupportedJavaVersion,
  stringVariableAllows,
  supportedJavaVersions,
  unavailableMinecraftJavaVersion,
  canPairMinecraftJavaVersionFields,
  defaultBrickInstanceName,
  latestStableVersion,
  interpolateBrickTemplate,
  javaVersionSelectOptions,
  usesLongStringBrickField,
  withRecommendedMinecraftJava,
} from "./brick-variables.js"

const paper = brickRecipeSchema.parse({
  format: "kiln.brick/v1",
  metadata: {
    id: "paper",
    name: "Paper",
    description: "Paper test recipe.",
    game: "Minecraft",
    author: "Kiln",
  },
  variables: {
    version: {
      type: "string",
      label: "Minecraft version",
      description: "Paper release to install.",
      required: true,
      default: "1.21.11",
      rules: { pattern: "^[0-9]+(?:\\.[0-9]+){1,2}$", maxLength: 32 },
    },
    java_version: {
      type: "string",
      label: "Java version",
      description: "Java Ember release.",
      required: true,
      default: "17",
      rules: { pattern: "^(?:11|17|21|25)$" },
    },
  },
  runtime: {
    image: "ghcr.io/kiln-site/bricks-java:{{ variables.java_version }}",
    name: "Java {{ variables.java_version }}",
    environment: {},
    resources: { memory: "2G" },
    storage: { mount: "/server" },
  },
  network: {
    mode: "minecraft-backend",
    primaryPort: "game",
    ports: [{ name: "game", container: 25_565, protocol: "tcp" }],
  },
  constraints: {},
})

describe("Minecraft Java defaults", () => {
  it("selects the newest stable version over snapshots and prereleases", () => {
    expect(
      latestStableVersion(["26.3-snapshot-9", "26.2", "26.2-rc-2", "26.1.2"])
    ).toBe("26.2")
    expect(latestStableVersion(["1.21.9", "1.21.11", "1.21.10"])).toBe(
      "1.21.11"
    )
    expect(latestStableVersion(["26.3-snapshot-9"])).toBeNull()
  })

  it("uses a brick name without its version for the server default", () => {
    expect(defaultBrickInstanceName({ ...paper, source: "paper.yml" })).toBe(
      "Paper Server"
    )
  })

  it("keeps generated server names within the write limit", () => {
    const brick = {
      ...paper,
      metadata: { ...paper.metadata, name: "A".repeat(80) },
      source: "paper.yml",
    }

    expect(defaultBrickInstanceName(brick)).toBe(`${"A".repeat(25)} Server`)
    expect(defaultBrickInstanceName(brick)).toHaveLength(32)
  })

  it.each([
    ["paper", "1.16.4", "11"],
    ["paper", "1.17.1", "17"],
    ["paper", "1.21.11", "21"],
    ["paper", "26.2", "25"],
    ["folia", "26.1", "25"],
    ["fabric", "1.17.1", "17"],
    ["fabric", "1.20.4", "17"],
    ["fabric", "1.20.5", "21"],
    ["fabric", "26.2", "25"],
  ])("maps %s %s to Java %s", (brickId, version, javaVersion) => {
    expect(requiredMinecraftJavaVersion(brickId, version)).toBe(javaVersion)
  })

  it("derives Java from the default and selected Minecraft versions", () => {
    expect(defaultBrickVariables({ ...paper, source: "paper.yml" })).toEqual({
      version: "1.21.11",
      java_version: "21",
    })
    expect(
      withRecommendedMinecraftJava("paper", paper.variables, {
        version: "26.2",
        java_version: "21",
      })
    ).toEqual({ version: "26.2", java_version: "25" })
    expect(defaultBrickRuntimeName({ ...paper, source: "paper.yml" })).toBe(
      "Java 21"
    )
    expect(
      interpolateBrickTemplate("-Xms{{ variables.min_memory }}", {
        min_memory: "768M",
      })
    ).toBe("-Xms768M")
  })

  it("hydrates missing legacy Startup variables without replacing overrides", () => {
    expect(
      hydrateBrickVariables(
        { ...paper, source: "paper.yml" },
        { version: "26.2" }
      )
    ).toEqual({ version: "26.2", java_version: "25" })
    expect(
      hydrateBrickVariables(
        { ...paper, source: "paper.yml" },
        { java_version: "21", version: "26.2" }
      )
    ).toEqual({ version: "26.2", java_version: "21" })
  })

  it("lists only published Java Embers the Brick accepts", () => {
    expect(supportedJavaVersions(paper.variables.java_version)).toEqual([
      "11",
      "17",
      "21",
      "25",
    ])
    expect(
      recommendedSupportedJavaVersion(
        "paper",
        paper.variables.java_version,
        "1.21.11"
      )
    ).toBe("21")
    expect(
      recommendedSupportedJavaVersion(
        "paper",
        paper.variables.java_version,
        "26.2"
      )
    ).toBe("25")
    expect(
      recommendedSupportedJavaVersion(
        "paper",
        paper.variables.java_version,
        "1.16.5"
      )
    ).toBe("17")
    expect(
      supportedJavaVersions({
        ...paper.variables.java_version,
        default: "graal-21",
        options: undefined,
        rules: { pattern: "^graal-[0-9]+$", maxLength: 16 },
      })
    ).toEqual([])
  })

  it("keeps valid custom Java versions in the selector", () => {
    const customJava = {
      ...paper.variables.java_version,
      default: "22",
      options: undefined,
      rules: { pattern: "^(?:17|22)$", maxLength: 2 },
    }
    expect(supportedJavaVersions(customJava)).toEqual(["17"])
    expect(javaVersionSelectOptions(customJava)).toEqual(["17", "22"])
    expect(javaVersionSelectOptions(customJava, "22")).toEqual(["17", "22"])
    expect(javaVersionSelectOptions(customJava, "17")).toEqual(["17", "22"])
    expect(
      javaVersionSelectOptions(
        {
          ...customJava,
          default: "graal-21",
          rules: { pattern: "^graal-[0-9]+$", maxLength: 16 },
        },
        "graal-21"
      )
    ).toEqual([])
    expect(
      recommendedSupportedJavaVersion("paper", customJava, "1.21.11")
    ).toBe("22")
  })

  it("rejects custom versions that break Brick pattern or length rules", () => {
    expect(stringVariableAllows(paper.variables.version, "1.21.11")).toBe(true)
    expect(stringVariableAllows(paper.variables.version, "26.2")).toBe(true)
    expect(stringVariableAllows(paper.variables.version, "latest")).toBe(false)
    expect(stringVariableAllows(paper.variables.version, "1.21.11-pre")).toBe(
      false
    )
    expect(
      stringVariableAllows(paper.variables.version, `${"1".repeat(33)}`)
    ).toBe(false)
  })

  it("keeps sensitive long strings out of the plaintext textarea", () => {
    const longFlags = {
      ...paper.variables.version,
      label: "Java arguments",
      required: false,
      default: undefined,
      rules: { maxLength: 2048 },
    }
    expect(usesLongStringBrickField(longFlags)).toBe(true)
    expect(
      usesLongStringBrickField({
        ...longFlags,
        sensitive: true,
      })
    ).toBe(false)
    expect(usesLongStringBrickField(paper.variables.version)).toBe(false)
  })

  it("only pairs Minecraft and Java fields when both are strings", () => {
    expect(canPairMinecraftJavaVersionFields(paper.variables)).toBe(true)
    expect(
      canPairMinecraftJavaVersionFields({
        ...paper.variables,
        version: { ...paper.variables.version, type: "number" },
      })
    ).toBe(false)
    expect(
      canPairMinecraftJavaVersionFields({
        version: paper.variables.version,
      })
    ).toBe(false)
  })

  it("blocks a required version with no default until a value is submitted", () => {
    const requiredVersion = {
      ...paper.variables.version,
      default: undefined,
    }
    expect(missingRequiredBrickVersion(requiredVersion, "")).toBe(true)
    expect(missingRequiredBrickVersion(requiredVersion, "   ")).toBe(true)
    expect(missingRequiredBrickVersion(requiredVersion, null)).toBe(true)
    expect(missingRequiredBrickVersion(requiredVersion, "1.21.11")).toBe(false)
    expect(missingRequiredBrickVersion(paper.variables.version, "")).toBe(false)
  })

  it("reports required Java Embers that are not published", () => {
    expect(
      unavailableMinecraftJavaVersion("paper", paper.variables, "1.16.5")
    ).toBe("16")
    expect(
      unavailableMinecraftJavaVersion("paper", paper.variables, "1.21.11")
    ).toBeNull()
    expect(
      unavailableMinecraftJavaVersion("paper", paper.variables, "1.16.5", "21")
    ).toBeNull()
  })
})
