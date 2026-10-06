import { expect, test } from "vite-plus/test"

import {
  DEFAULT_KILN_GIT_REPO,
  LEGACY_KILN_GIT_REPO,
  isKilnGitRepositorySource,
  kilnCliPackageName,
  kilnDefaultEmberImage,
  kilnImageSource,
} from "./git-repository"

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

test("official releases retain the image source label older Relays require", () => {
  expect(kilnImageSource(DEFAULT_KILN_GIT_REPO)).toBe(LEGACY_KILN_GIT_REPO)
  expect(
    isKilnGitRepositorySource(LEGACY_KILN_GIT_REPO, DEFAULT_KILN_GIT_REPO)
  ).toBe(true)
})

test("a fork accepts its own image provenance but never upstream's", () => {
  expect(kilnImageSource(repository)).toBe(repository)
  expect(isKilnGitRepositorySource(repository, repository)).toBe(true)
  expect(isKilnGitRepositorySource(LEGACY_KILN_GIT_REPO, repository)).toBe(
    false
  )
  expect(isKilnGitRepositorySource(DEFAULT_KILN_GIT_REPO, repository)).toBe(
    false
  )
})
