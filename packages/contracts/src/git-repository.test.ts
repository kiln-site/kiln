import { expect, test } from "vite-plus/test"

import { kilnCliPackageName, kilnDefaultEmberImage } from "./git-repository"

const repository = "https://github.com/example/fork"

test("CLI identity supports scoped fork packages and rejects shell syntax", () => {
  expect(kilnCliPackageName(undefined, repository)).toBe("@example/fork-cli")
  expect(kilnCliPackageName("@my-npm-org/cli", repository)).toBe(
    "@my-npm-org/cli"
  )
  for (const name of [
    "cli&whoami",
    "cli%PATH%",
    "cli@latest",
    "$(whoami)",
    "--registry=evil",
  ])
    expect(() => kilnCliPackageName(name)).toThrow()
})

test("default fork catalog selects fork Embers without rewriting third-party images", () => {
  expect(
    kilnDefaultEmberImage(
      "ghcr.io/kiln-site/bricks-java:{{ variables.java_version }}",
      repository
    )
  ).toBe("ghcr.io/example/fork/bricks-java:{{ variables.java_version }}")
  expect(
    kilnDefaultEmberImage(
      "ghcr.io/kiln-site/bricks-steamcmd:latest",
      repository
    )
  ).toBe("ghcr.io/example/fork/bricks-steamcmd:latest")
  expect(kilnDefaultEmberImage("custom/java:21", repository)).toBe(
    "custom/java:21"
  )
})
